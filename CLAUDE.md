# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Scikit-Learner is a **fully static, single-page web app** that runs scikit-learn in the user's browser via Pyodide (CPython compiled to WebAssembly). There is **no backend** — what looks like API calls in the JS layer are Python function calls dispatched into the in-browser Pyodide runtime. Deployment is just hosting `frontend/` on a static host (Netlify, configured in `netlify.toml`).

The `landing/` directory is a separate marketing page; the app proper is `frontend/`.

## Running locally

```bash
python3 -m http.server -d frontend 8080
# then open http://localhost:8080/
```

No build step, no dependency install, no backend process. Pyodide and its packages (`scikit-learn`, `pandas`, `numpy`, `scipy`, `joblib`) are fetched from the JSDelivr CDN at runtime — **the app requires internet access on first load** (~15 MB, ~10 s). Subsequent loads are cached.

`pyproject.toml` and `.python-version` exist only because the project was historically a FastAPI backend — they have no role in the current deployment. `dependencies = []` is intentional.

## Architecture: the JS ↔ Python bridge

The whole app pivots around three files. Understanding the contract between them is the key to being productive here.

- **`frontend/py/learner.py`** — pure Python module. Every former HTTP endpoint is a top-level function (`upload_csv`, `load_sample`, `train`, `train_all`, `predictions`, `scatter_data`, `export_model`, `bulk_zip`, `comparison`, etc.) that takes JSON-serializable args and returns a `dict` (or raw `bytes` for downloads). Module-level `current_data` dict holds session state — dataframe, trained models, task type. Each browser tab is its own Pyodide instance, so global state is fine.
- **`frontend/js/pyodide-bridge.js`** — boots Pyodide, loads packages, copies `data/airfoil.csv` into the Pyodide MEMFS at `/data/airfoil.csv`, executes `learner.py`, then exposes a tiny surface on `window`:
  - `pyCall(fnName, [primitiveArgs])` — for JSON-able calls. Builds a Python expression string and runs it via `runPython`. Result is converted with `toJs({dict_converter: Object.fromEntries})`.
  - `pyCallBinary(fnName, Uint8Array, extraArgs)` — passes a binary buffer via a `globals.set('__bridge_buf', ...)` shim (used by `upload_csv`).
  - `downloadBytes(bytes, filename, mime)` — triggers a browser download.
  - `window.pyodideReady()` and the `pyodide-ready` event signal when the runtime is up.
- **`frontend/js/app.js`** — all UI logic. Builds DOM, wires Bootstrap controls, renders Plotly charts. Calls `pyCall('train', [...])` etc. instead of `fetch()`. Waits for `pyodide-ready` before its first call. The `API_BASE` constant is a vestigial leftover from the FastAPI version and is unused.

### Adding a new Python-side capability

1. Add a top-level function in `learner.py`. It must accept and return only JSON-serializable values (or `bytes` for downloads). Use `ValueError` for user-facing errors — the bridge surfaces these as UI error messages.
2. If a list/dict comes from JS, defensively unwrap PyProxies: `if hasattr(x, "to_py"): x = list(x.to_py())`. The bridge passes primitives as Python literals (so JS arrays arrive as Python lists), but uploaded binary args arrive as JsProxy.
3. From `app.js`, call it: `const result = await pyCall('your_fn', [arg1, arg2]);`. No JS-side schema needed.
4. **Hot-reload caveat**: editing `learner.py` requires a hard-reload (Cmd-Shift-R) for Pyodide to re-import it. A normal reload re-fetches the file but the module stays cached.

### Adding a model

Add to `AVAILABLE_MODELS` (regression) or `AVAILABLE_CLASSIFICATION_MODELS` (classification) in `learner.py`. The dict key becomes the model identifier used end-to-end; `category` controls UI grouping. The UI picks the right dict via the active `task_type`.

### Bundled data

`frontend/data/airfoil.csv` is shipped in-repo and copied into Pyodide MEMFS at boot. The original FastAPI version used `fetch_openml`, which doesn't work in-browser. Other sample datasets come from `sklearn.datasets` (loaded lazily) or are synthesized in `load_sample()`.

## Conventions worth knowing

- **Don't try to add real HTTP endpoints or a Python web server** — the entire point is static deployment. New features go through the `pyCall` bridge.
- **20 MB CSV upload cap** is dictated by Pyodide's WASM heap, not by code. Don't add code to "fix" this — document the limit.
- **Boston Housing is synthesized**, not loaded from sklearn (removed in sklearn ≥1.2). The synthetic generator is in `load_sample()` under `dataset_key == "boston"`.
- **Pyodide version** is pinned in `pyodide-bridge.js` (`PYODIDE_VERSION`). Bumping it may shift which scikit-learn version is bundled — verify the model dict still works.

## Testing

The README mentions a Playwright end-to-end spec covering Pyodide bootstrap, sample loading, training, predictions, export, and the scatter-plot render (8 assertions). The spec file is not currently in the repo — if asked to add tests, ask the user where the spec lives or whether to scaffold a fresh one.
