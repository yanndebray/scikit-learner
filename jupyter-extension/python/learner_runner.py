"""Scikit-Learner's kernel-side runner, for JupyterLab and JupyterLite.

The third host for one ML layer. The web app calls `learner.py` through a
Pyodide bridge; the VS Code extension execs it in a subprocess and talks
line-delimited JSON over stdin/stdout (`../vscode-extension/python/
learner_server.py`); here it is exec'd inside the *notebook kernel* and its
top-level functions are served over IOPub.

This module is never pip-installed. The JavaScript pushes its source into the
kernel and execs it as ``_sklearner_runner`` — because the environment the
Jupyter server runs in is routinely not the one the kernel runs in, so a
server-side install would land in the wrong Python, and because JupyterLite
has no server to install into at all. It also means the same code runs against
CPython and against Pyodide with nothing to configure.

Nothing but the standard library is imported at module scope, so the module
can be injected into a kernel that cannot yet import pandas — ``probe()`` is
how the host finds that out, and it has to work before the fix is applied.

Protocol
    Request   {"id": int, "fn": str, "args": [...], "buf": "<base64>"?}
              "buf" is decoded to bytes and prepended to args — the upload_csv
              path, mirroring pyCallBinary in the web app.
    Response  {"id": int, "ok": true,  "result": <json>}
              {"id": int, "ok": true,  "bin": "<base64>"}   for bytes results
              {"id": int, "ok": false, "error": str, "user": bool}
              "user" is true for ValueError — learner.py's contract for
              messages meant for the UI rather than the log.

Responses travel as an ``application/json`` display bundle, so the host reads
a real object off the wire instead of parsing a repr, which can be truncated
and whose quoting is a minefield. Where ``IPython.display`` is unavailable the
same JSON goes to stdout behind a sentinel prefix.

The strict rule from the other two hosts survives: **stdout is a protocol and
stderr is a log.** sklearn warns freely about convergence and deprecations; on
stdout that would corrupt a response. Progress lines go to stderr prefixed
with ``::``, which the extension picks up off IOPub stream messages.
"""

from __future__ import annotations

import base64
import json
import sys
import traceback

#: Prefix for the stdout fallback. Long and unlovely on purpose — it must not
#: collide with anything a user's own print could produce.
SENTINEL = "@@SCIKIT-LEARNER-JSON@@"

#: What learner.py needs before it can even be imported. Order matters only in
#: that it is the order the user sees in the "missing packages" message.
REQUIRED = ["numpy", "pandas", "scipy", "joblib", "sklearn"]

#: Distribution names for the ones whose import name differs.
DISTRIBUTION = {"sklearn": "scikit-learn"}

#: The learner.py namespace, once booted. None until then.
_learner: dict | None = None

#: Where the bundled airfoil CSV was written, so a re-boot can reuse it.
_airfoil_path: str | None = None


def progress(message: str) -> None:
    """A line the user may want to read while something slow happens."""
    print(f"::{message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    """The one and only way a response leaves this module."""
    try:
        from IPython.display import display

        display({"application/json": payload}, raw=True)
        return
    except Exception:  # noqa: BLE001 — no IPython, or a display hook that threw
        pass
    sys.stdout.write(SENTINEL + json.dumps(payload) + "\n")
    sys.stdout.flush()


def sanitize(value):
    """Make a learner.py return value safe for ``JSON.parse``.

    Two hazards. NaN and Infinity are valid to ``json.dumps`` and invalid to
    every JSON parser on the JavaScript side — ``describe()`` on a column with
    missing values produces them routinely. And numpy scalars survive as far
    as the serializer before failing, because learner.py returns whatever
    sklearn handed it.
    """
    if isinstance(value, float):
        return value if -1e308 < value < 1e308 or value == value else None
    if isinstance(value, dict):
        return {str(k): sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    if isinstance(value, (str, bool, int)) or value is None:
        return value
    # numpy scalars and 0-d arrays answer to .item(); arrays to .tolist().
    for method in ("tolist", "item"):
        converter = getattr(value, method, None)
        if callable(converter):
            try:
                return sanitize(converter())
            except (ValueError, TypeError):
                pass
    return value


def probe() -> dict:
    """What this kernel is and what it is missing. Never raises.

    Called before anything is installed or booted, so it may only use the
    standard library — importing pandas here to check for pandas would be the
    same crash it exists to report.
    """
    import importlib
    import importlib.util
    import platform

    # This function runs again immediately after a `%pip install`, in the same
    # live interpreter, where the path finders hold a listing of site-packages
    # that predates it. IPython's %pip invalidates the caches itself and
    # piplite does not need to, so in practice both paths work without this —
    # but a stale cache here reports the packages that were just installed as
    # still missing, and the runtime concludes the install "did not take",
    # which is an unfalsifiable-looking bug. One cheap call closes it.
    importlib.invalidate_caches()

    missing = [name for name in REQUIRED if importlib.util.find_spec(name) is None]

    versions: dict[str, str] = {}
    for name in REQUIRED:
        if name in missing:
            continue
        try:
            module = __import__(name)
            version = getattr(module, "__version__", None)
            if version:
                versions[name] = str(version)
        except Exception:  # noqa: BLE001 — versions are cosmetic
            pass

    return {
        "ok": True,
        "platform": sys.platform,
        # sys.platform == "emscripten" is how a Pyodide kernel identifies
        # itself, and it is what decides between piplite and %pip.
        "pyodide": sys.platform == "emscripten",
        "python": platform.python_version(),
        "missing": missing,
        "install": [DISTRIBUTION.get(name, name) for name in missing],
        "versions": versions,
        "booted": _learner is not None,
    }


def boot(learner_b64: str, airfoil_b64: str) -> dict:
    """Exec learner.py into a namespace of its own. Idempotent per kernel.

    The one adaptation, and it is the same one learner_server.py makes:
    learner.py reads the bundled airfoil CSV from ``/data/airfoil.csv``
    because the Pyodide bridge vendors it into MEMFS at that path. Here the
    bytes arrive over the wire, get written to a temp file, and the literal
    is rewritten to point at it before exec.
    """
    global _learner, _airfoil_path

    if _learner is not None:
        return {"ok": True, "already": True, **probe()}

    import os
    import tempfile

    try:
        source = base64.b64decode(learner_b64).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"could not decode learner.py: {exc}"}

    if _airfoil_path is None or not os.path.exists(_airfoil_path):
        directory = os.path.join(tempfile.gettempdir(), "scikit-learner")
        os.makedirs(directory, exist_ok=True)
        _airfoil_path = os.path.join(directory, "airfoil.csv")
        with open(_airfoil_path, "wb") as handle:
            handle.write(base64.b64decode(airfoil_b64))

    source = source.replace('"/data/airfoil.csv"', json.dumps(_airfoil_path))

    progress("importing scikit-learn — a few seconds, once per kernel")
    namespace: dict = {"__name__": "learner"}
    try:
        exec(compile(source, "<learner.py>", "exec"), namespace)
        ready = namespace.get("_ready")
        if not callable(ready) or ready() != "ok":
            raise RuntimeError("learner module did not initialize cleanly")
    except Exception as exc:  # noqa: BLE001 — whatever failed, the host needs it
        traceback.print_exc(file=sys.stderr)
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    _learner = namespace
    return {"ok": True, "already": False, **probe()}


def reset() -> dict:
    """Drop the dataframe and every fitted model, without restarting Python.

    The VS Code extension answers "Restart Python runtime" by killing the
    subprocess. A kernel is shared with the user's own notebook work, so the
    equivalent here throws away only what belongs to Scikit-Learner.
    """
    global _learner
    _learner = None
    return {"ok": True}


def call(request: dict) -> dict:
    """Dispatch one request against the learner.py namespace. Never raises."""
    req_id = request.get("id")
    fn_name = request.get("fn", "")

    if _learner is None:
        return {
            "id": req_id,
            "ok": False,
            "error": "the Scikit-Learner runtime is not booted in this kernel",
            "user": False,
        }

    args = list(request.get("args") or [])
    if request.get("buf") is not None:
        args.insert(0, base64.b64decode(request["buf"]))

    fn = _learner.get(fn_name)
    if not callable(fn) or fn_name.startswith("_"):
        return {"id": req_id, "ok": False, "error": f"unknown function: {fn_name}", "user": False}

    try:
        result = fn(*args)
    except ValueError as exc:
        # learner.py's contract: ValueError is a message for the user.
        return {"id": req_id, "ok": False, "error": str(exc), "user": True}
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        return {
            "id": req_id,
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "user": False,
        }

    if isinstance(result, (bytes, bytearray)):
        return {
            "id": req_id,
            "ok": True,
            "bin": base64.b64encode(bytes(result)).decode("ascii"),
        }
    return {"id": req_id, "ok": True, "result": sanitize(result)}


def dispatch(request_b64: str) -> None:
    """The entry point the extension executes, and the only one it needs.

    The request arrives base64-encoded so the generated cell is a single
    ASCII string literal: a CSV full of quotes, backslashes and newlines has
    no way to break out of it, and neither does a column name.
    """
    try:
        request = json.loads(base64.b64decode(request_b64).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        emit({"id": None, "ok": False, "error": f"bad request: {exc}", "user": False})
        return

    kind = request.get("kind", "call")
    try:
        if kind == "probe":
            payload = {"id": request.get("id"), "ok": True, "result": probe()}
        elif kind == "boot":
            result = boot(request["learner"], request["airfoil"])
            payload = {
                "id": request.get("id"),
                "ok": bool(result.get("ok")),
                "result": result,
                "error": result.get("error"),
                "user": False,
            }
        elif kind == "reset":
            payload = {"id": request.get("id"), "ok": True, "result": reset()}
        else:
            payload = call(request)
    except Exception as exc:  # noqa: BLE001 — dispatch itself must not throw
        traceback.print_exc(file=sys.stderr)
        payload = {
            "id": request.get("id"),
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "user": False,
        }

    emit(payload)
