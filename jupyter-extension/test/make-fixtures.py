#!/usr/bin/env python3
"""Build the CSV fixtures the methodology gates are tested against.

Every bundled sample dataset is clean by construction — their target column is
literally named `target`, they have no missing values and no identifiers — so
none of them trips a single gate. That is the right default (a check that fires
on iris would get switched off within a day), but it leaves nothing to test
with. This writes a file that trips five of the six on purpose.

    python jupyter-extension/test/make-fixtures.py

Needs numpy and pandas. Seeded, so the output is byte-identical every run and
a rebuilt JupyterLite site does not change.

churn-messy.csv, column by column, and which gate each one is for:

    customer_id      G-LEAK-ID     strictly increasing, unique per row, and
                                   named like a key — three reasons at once
    signup_date      G-CV-TIME     a time axis under shuffled folds
    tenure_months    —             an honest feature
    monthly_charges  G-DROPNA      15% of its values are missing, so 45 of
                                   300 rows are dropped before fitting
    support_tickets  —             an honest feature
    churned          G-TARGET      not named `target`, so it was guessed
                     G-TASK        integer 0/1 about to be fitted by
                                   regression, because upload_csv infers
                                   regression for a numeric target

G-CV-SPLITTER does not fire here: it only applies once the task is
classification, which is what answering G-TASK does. Answer that gate in the
panel and the rare-class warning appears — the chain is deliberate.
"""

from __future__ import annotations

import pathlib

import numpy as np
import pandas as pd

HERE = pathlib.Path(__file__).resolve().parent
# Next to the other JupyterLite seed contents, so `jupyter lite build
# --contents files` picks it up and the demo site has something to open.
TARGET = HERE.parent / "lite" / "files" / "churn-messy.csv"

ROWS = 300
MISSING = 45


def build() -> pd.DataFrame:
    rng = np.random.default_rng(0)
    frame = pd.DataFrame(
        {
            "customer_id": np.arange(1, ROWS + 1),
            "signup_date": pd.date_range("2024-01-01", periods=ROWS).astype(str),
            "tenure_months": rng.integers(1, 60, ROWS).astype(float),
            "monthly_charges": rng.normal(70, 20, ROWS).round(2),
            "support_tickets": rng.poisson(1.2, ROWS),
            # ~7% positives, so the class is rare enough for the splitter gate
            # to have something to say once the task is set to classification.
            "churned": (rng.random(ROWS) < 0.07).astype(int),
        }
    )
    holes = rng.choice(ROWS, MISSING, replace=False)
    frame.loc[holes, "monthly_charges"] = np.nan
    return frame


def main() -> None:
    frame = build()
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(TARGET, index=False)
    positives = int(frame["churned"].sum())
    print(f"wrote {TARGET.relative_to(HERE.parent.parent)}")
    print(f"  {len(frame)} rows × {len(frame.columns)} columns")
    print(f"  {int(frame['monthly_charges'].isna().sum())} missing in monthly_charges")
    print(f"  {positives} positives ({100 * positives / len(frame):.1f}%)")


if __name__ == "__main__":
    main()
