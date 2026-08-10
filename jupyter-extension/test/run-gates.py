#!/usr/bin/env python3
"""Run the methodology gates over a CSV and print what they find.

    python jupyter-extension/test/run-gates.py path/to/your.csv
    python jupyter-extension/test/run-gates.py your.csv --target churned
    python jupyter-extension/test/run-gates.py --sample iris
    python jupyter-extension/test/run-gates.py your.csv --task classification

No JupyterLab, no browser, no kernel — this loads frontend/py/learner.py the
same way every shell does and calls run_gates() directly, so it is the fastest
way to see whether a dataset trips anything and the easiest thing to point at
when a finding looks wrong.

Exits 1 if any `leak` was found, 0 otherwise, so it can gate a script.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import textwrap

REPO = pathlib.Path(__file__).resolve().parents[2]
LEARNER = REPO / "frontend" / "py" / "learner.py"

# Severity → how it prints. The word is the point: colour alone would not
# survive a pipe into a file, and these are meant to be pasted into issues.
MARK = {"leak": "LEAK  ", "decide": "DECIDE", "note": "note  "}


def load_learner() -> dict:
    source = LEARNER.read_text(encoding="utf-8")
    airfoil = REPO / "frontend" / "data" / "airfoil.csv"
    # learner.py reads the bundled CSV from the path the Pyodide bridge
    # vendors it to; rewrite it exactly as the other loaders do.
    source = source.replace('"/data/airfoil.csv"', repr(str(airfoil)))
    namespace: dict = {"__name__": "learner"}
    exec(compile(source, str(LEARNER), "exec"), namespace)
    return namespace


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv", nargs="?", type=pathlib.Path, help="a .csv to check")
    parser.add_argument("--sample", help="a bundled sample instead (iris, airfoil, …)")
    parser.add_argument("--target", help="target column; default is learner.py's own guess")
    parser.add_argument("--task", choices=["regression", "classification"])
    parser.add_argument("--cv", type=int, default=5, help="fold count (default 5)")
    args = parser.parse_args()

    if not args.csv and not args.sample:
        parser.error("give a CSV path or --sample")

    learner = load_learner()

    if args.sample:
        info = learner["load_sample"](args.sample)
        label = f"sample:{args.sample}"
    else:
        if not args.csv.exists():
            print(f"no such file: {args.csv}", file=sys.stderr)
            return 2
        info = learner["upload_csv"](args.csv.read_bytes(), args.csv.name)
        label = str(args.csv)

    state = learner["current_data"]
    if args.target:
        if args.target not in state["columns"]:
            print(f"{args.target!r} is not a column. Columns: {', '.join(state['columns'])}",
                  file=sys.stderr)
            return 2
        state["target"] = args.target
    if not state.get("target"):
        # learner.py leaves the target unset; every shell then applies the same
        # rule, so the CLI has to as well or it checks a configuration nobody
        # ever runs.
        numeric = state["numeric_columns"]
        state["target"] = "target" if "target" in numeric else (numeric[-1] if numeric else None)
    target = state.get("target")
    task = args.task or state.get("task_type")
    features = [c for c in state["numeric_columns"] if c != target]

    print(f"{label}  {info['stats']['rows']} rows × {len(state['columns'])} columns")
    print(f"target={target}  task={task}  features={len(features)}  cv={args.cv}\n")

    report = learner["run_gates"](features, target, task, args.cv)
    counts = report["counts"]

    if not report["gates"]:
        print("Nothing to flag.")
    for gate in sorted(report["gates"], key=lambda g: {"leak": 0, "decide": 1, "note": 2}[g["severity"]]):
        print(f"[{MARK[gate['severity']]}] {gate['id']}  {gate['title']}")
        for line in textwrap.wrap(gate["detail"], 76):
            print(f"           {line}")
        if gate.get("columns"):
            for column in gate["columns"]:
                print(f"           · {column['column']} — {column['why']}")
        if gate.get("options"):
            for option in gate["options"][:6]:
                flag = " (suggested)" if option.get("recommended") else ""
                print(f"           → {option['label']}{flag}")
        print()

    print(f"{counts['leak']} leak · {counts['decide']} decide · {counts['note']} note")
    return 1 if counts["leak"] else 0


if __name__ == "__main__":
    sys.exit(main())
