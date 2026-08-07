"""Scikit-Learner's local Python runtime for the VS Code extension.

Loads the same learner.py the web app runs in Pyodide, then serves its
top-level functions over a line-delimited JSON protocol: one request object
per line on stdin, one response object per line on stdout.

The strict rule is that **stdout is a protocol and stderr is a log**. sklearn
warns freely (convergence, deprecations); if any of that reached stdout it
would corrupt a response. Warnings and tracebacks go to stderr.

Request   {"id": int, "fn": str, "args": [...], "buf": "<base64>"?}
          If "buf" is present it is decoded to bytes and prepended to args
          (the upload_csv path — mirrors pyCallBinary in the web app).
Response  {"id": int, "ok": true, "result": <json>}
          {"id": int, "ok": true, "bin": "<base64>"}     for bytes results
          {"id": int, "ok": false, "error": str, "user": bool}
          "user" is true for ValueError — learner.py's contract for messages
          meant to be shown in the UI, not logged as crashes.

On startup the server prints {"event": "ready"} once learner.py has been
imported, or {"event": "fatal", "error": ...} if it can't be.
"""

from __future__ import annotations

import base64
import json
import math
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def load_learner() -> dict:
    """Exec learner.py into a namespace, exactly as the Pyodide bridge does.

    The one adaptation: learner.py reads the bundled airfoil CSV from
    "/data/airfoil.csv" because the bridge vendors it into the Pyodide MEMFS
    at that path. Locally the file ships next to this script, so the literal
    is rewritten to the real path before exec.
    """
    source = (HERE / "learner.py").read_text(encoding="utf-8")
    airfoil = HERE / "data" / "airfoil.csv"
    source = source.replace('"/data/airfoil.csv"', json.dumps(str(airfoil)))
    namespace: dict = {"__name__": "learner"}
    exec(compile(source, str(HERE / "learner.py"), "exec"), namespace)
    return namespace


def sanitize(value):
    """NaN/Infinity are valid to json.dumps but not to JSON.parse on the JS
    side. describe() on a column with missing values produces NaN; map those
    to null rather than poisoning the whole response."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    return value


def main() -> None:
    try:
        learner = load_learner()
        ready = learner.get("_ready")
        if not callable(ready) or ready() != "ok":
            raise RuntimeError("learner module did not initialize cleanly")
    except Exception as exc:  # noqa: BLE001 — whatever failed, the host needs it
        traceback.print_exc(file=sys.stderr)
        emit({"event": "fatal", "error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "ok": False, "error": f"bad request: {exc}", "user": False})
            continue

        req_id = req.get("id")
        fn_name = req.get("fn", "")
        args = list(req.get("args") or [])
        if "buf" in req:
            args.insert(0, base64.b64decode(req["buf"]))

        fn = learner.get(fn_name)
        if not callable(fn) or fn_name.startswith("_"):
            emit({"id": req_id, "ok": False, "error": f"unknown function: {fn_name}", "user": False})
            continue

        try:
            result = fn(*args)
        except ValueError as exc:
            emit({"id": req_id, "ok": False, "error": str(exc), "user": True})
            continue
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            emit({"id": req_id, "ok": False, "error": f"{type(exc).__name__}: {exc}", "user": False})
            continue

        if isinstance(result, (bytes, bytearray)):
            emit({"id": req_id, "ok": True, "bin": base64.b64encode(bytes(result)).decode("ascii")})
        else:
            emit({"id": req_id, "ok": True, "result": sanitize(result)})


if __name__ == "__main__":
    main()
