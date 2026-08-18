# Scikit-Learner for VS Code

A native VS Code ML workbench on scikit-learn, built on the Probabl design system (see issue #17): pick a CSV or sample dataset in the sidebar, train 20+ models, compare runs, read the generated sklearn pipeline, export the best model as joblib.

Everything runs in a **local Python environment** — real CPython, your machine's full speed and memory, nothing sent anywhere.

## The surface

- **Activity bar → Scikit-Learner** (the scikit-learn spark): four sidebar views.
  - **Dataset** — workspace CSVs when nothing is loaded; the loaded file plus target / features / task / validation rows (click to change) once there is.
  - **Models** — the catalog as a checkbox tree grouped by category; ▶ in the header trains the checked set, *Train all* in the overflow menu.
  - **Runs** — ranked results with scores; running / queued / failed states live here during training. Click a run to plot it; expand it for its metrics and hyperparameters.
  - **Artifacts** — generated `pipeline.py` and `metrics.json` (read-only virtual documents), plus a `.joblib` export per trained run.
- **Editor tab** — plots (hand-rolled SVG, no CDNs) that follow your VS Code color theme, including `charts.*` colors: Scatter, Predicted vs actual, Residuals or Confusion matrix + ROC, Comparison table, with Save PNG and a ⚙ popover for plot controls. The chart always gets the full editor width — run details live in the sidebar, so narrow splits stay usable.
- **Probabl Dark** — a complete bundled color theme (midnight indigo + orange spark, sky accents) covering workbench, syntax, terminal and chart colors. `Preferences: Color Theme → Probabl Dark` restores the full brand look from the design mock.
- **Status bar** — Python env + training progress (`Training 2 of 4`) or `n runs · best 0.967`.
- **Output → Scikit-Learner** — one log line per trained model.

On first use the extension finds a Python with scikit-learn (setting → its managed env → the Python extension's env → workspace venv → PATH) or offers to set one up with [uv](https://github.com/astral-sh/uv) (pip fallback).

## How it works

The ML layer is the same `learner.py` the [web app](https://scikit-learner.app) runs in Pyodide — copied from `../frontend` at build time, never forked. `python/learner_server.py` serves its functions over line-delimited JSON on stdin/stdout; one long-lived process per session holds the dataframe and fitted models, exactly like the web app's per-tab Pyodide instance.

Since 0.2.0 the UI is native: an extension-host `Session` model (`src/session.ts`) is the single source of truth, and the tree views, status bar, plots webview and generated documents are all pure renderers of it. The plots webview is self-contained — no Plotly, no Bootstrap, no network. Since 0.2.1 it draws every color from the active theme's `--vscode-*` variables (and re-renders live on theme switch); the brand appearance ships as the separate "Probabl Dark" color theme.

## Development

```bash
npm install
npm run build        # sync learner.py/airfoil.csv from ../frontend + esbuild
npm test             # server protocol tests + VS Code integration tests
npm run package      # produce the .vsix
```

The Python-dependent tests use `$SCIKIT_LEARNER_TEST_PYTHON` (an interpreter with scikit-learn, pandas, joblib) and skip when it isn't set and `python3` lacks sklearn.
