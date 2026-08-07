# Scikit-Learner for VS Code

The [scikit-learner](https://scikit-learner.app) app as a VS Code panel: load a
CSV or a sample dataset, train 20+ scikit-learn models, compare them visually,
export the best one as a joblib file.

Where the web app runs scikit-learn in the browser via Pyodide, this extension
runs it in a **local Python environment** — real CPython, your machine's full
speed and memory, nothing sent anywhere.

## Usage

Run **“Scikit-Learner: Open”** from the command palette. On first use the
extension finds a Python with scikit-learn (your setting → its own managed
environment → the Python extension's active env → a workspace venv → PATH) or
offers to set one up — with [uv](https://github.com/astral-sh/uv) when
available, `venv` + `pip` otherwise.

Commands:

- **Open Scikit-Learner** — the app panel
- **Set up local Python environment** — provision the managed env now
- **Select Python interpreter…** — pin a specific interpreter
- **Restart Python runtime** — fresh session (clears loaded data and models)
- **Remove managed environment** / **Show log**

## How it works

The frontend (`app.js`, `styles.css`) and the ML layer (`learner.py`) are the
same files the web app ships — copied from `../frontend` at build time by
`scripts/sync-assets.mjs`, never forked. Two swaps make it an extension:

- `webview/vscode-bridge.js` replaces `pyodide-bridge.js`: same surface
  (`pyCall`, `pyCallBinary`, `downloadBytes`, the ready event), but calls are
  posted to the extension host instead of into a WASM runtime.
- `python/learner_server.py` loads `learner.py` and serves its functions over
  line-delimited JSON on stdin/stdout — one long-lived process per panel,
  mirroring the web app's one-Pyodide-instance-per-tab session model.

Bootstrap and Plotly still load from their CDNs, exactly like the web app, so
the panel needs internet on first render.

## Development

```bash
npm install
npm run build        # sync assets from ../frontend + esbuild
npm test             # server protocol tests + VS Code integration tests
npm run package      # produce the .vsix
```

The Python-dependent tests use `$SCIKIT_LEARNER_TEST_PYTHON` (an interpreter
with scikit-learn, pandas, joblib) and skip when it isn't set and `python3`
lacks sklearn.
