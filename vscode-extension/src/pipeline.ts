import * as vscode from "vscode";
import type { CatalogModel, Run, Session } from "./session";

/* ------------------------------------------------------------------ */
/*  Generated artifacts: pipeline.py and metrics.json.                 */
/*                                                                     */
/*  pipeline.py is the sklearn code equivalent to the selected run —   */
/*  a real read-only document, not webview HTML, so it gets syntax     */
/*  highlighting, copy and save-as for free. It is the "graduation"    */
/*  path: the GUI shows the code you'd write next.                     */
/* ------------------------------------------------------------------ */

export const SCHEME = "scikit-learner";

export function pipelineUri(): vscode.Uri {
  return vscode.Uri.parse(`${SCHEME}:pipeline.py`);
}
export function metricsUri(): vscode.Uri {
  return vscode.Uri.parse(`${SCHEME}:metrics.json`);
}

export class ArtifactProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly session: Session) {
    session.onDidChange(() => {
      this.emitter.fire(pipelineUri());
      this.emitter.fire(metricsUri());
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.path === "metrics.json") return this.metricsJson();
    return this.pipelinePy();
  }

  private metricsJson(): string {
    const ds = this.session.dataset;
    return JSON.stringify(
      {
        dataset: ds
          ? {
              filename: ds.filename,
              rows: ds.rows,
              task: ds.taskType,
              target: ds.target,
              features: ds.features,
              validation: `${ds.cvFolds}-fold cross-validation`,
            }
          : null,
        runs: this.session.runs
          .filter((r) => r.status === "done")
          .map((r) => ({
            model: r.key,
            name: r.name,
            category: r.category,
            metrics: r.metrics,
            fit_seconds: r.fitSeconds,
            trained_at: r.trainedAt ? new Date(r.trainedAt).toISOString() : undefined,
          })),
      },
      null,
      2
    );
  }

  private pipelinePy(): string {
    const ds = this.session.dataset;
    const run = this.session.selectedRun() ?? this.session.bestRun();
    if (!ds || !run) {
      return "# Train a model first — this file shows the sklearn code\n# equivalent to the selected run.\n";
    }
    const model = this.session.catalog.find((m) => m.key === run.key);
    return generatePipeline(ds, run, model);
  }
}

function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return `(${v.map(pyLiteral).join(", ")}${v.length === 1 ? "," : ""})`;
  return JSON.stringify(v);
}

const SAMPLE_LOADERS: Record<string, string> = {
  iris: `from sklearn.datasets import load_iris

data = load_iris()
df = pd.DataFrame(data.data, columns=data.feature_names)
df["target"] = data.target`,
  wine: `from sklearn.datasets import load_wine

data = load_wine()
df = pd.DataFrame(data.data, columns=data.feature_names)
df["target"] = data.target`,
  breast_cancer: `from sklearn.datasets import load_breast_cancer

data = load_breast_cancer()
df = pd.DataFrame(data.data, columns=data.feature_names)
df["target"] = data.target`,
  digits: `from sklearn.datasets import load_digits

data = load_digits()
df = pd.DataFrame(data.data, columns=[f"pixel_{i}" for i in range(64)])
df["target"] = data.target`,
  diabetes: `from sklearn.datasets import load_diabetes

data = load_diabetes()
df = pd.DataFrame(data.data, columns=data.feature_names)
df["target"] = data.target`,
  synthetic: `from sklearn.datasets import make_regression

X_raw, y_raw = make_regression(n_samples=500, n_features=5, noise=10, random_state=42)
df = pd.DataFrame(X_raw, columns=[f"feature_{i}" for i in range(5)])
df["target"] = y_raw`,
};

function loadBlock(ds: NonNullable<Session["dataset"]>): string {
  if (ds.source === "file" && ds.fileUri) {
    return `df = pd.read_csv(${pyLiteral(vscode.workspace.asRelativePath(ds.fileUri))})`;
  }
  const loader = ds.sampleKey && SAMPLE_LOADERS[ds.sampleKey];
  if (loader) return loader;
  return `# "${ds.sampleKey}" is a dataset bundled with Scikit-Learner; point this at your copy.
df = pd.read_csv("${ds.filename}")`;
}

export function generatePipeline(
  ds: NonNullable<Session["dataset"]>,
  run: Run,
  model?: CatalogModel
): string {
  const cls = model?.className ?? "LinearRegression";
  const mod = model?.module ?? "sklearn.linear_model";
  const params = Object.entries(model?.params ?? {})
    .map(([k, v]) => `${k}=${pyLiteral(v)}`)
    .join(", ");
  const isClf = ds.taskType === "classification";
  const scoring = isClf ? "accuracy" : "r2";

  return `"""Generated by Scikit-Learner for VS Code.

The sklearn code equivalent to the run "${run.name}" on ${ds.filename}
(${ds.rows} rows, ${ds.cvFolds}-fold cross-validation). Edit freely — this
file is a snapshot, not a live view.
"""

import joblib
import pandas as pd
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler
from ${mod} import ${cls}

# -- data --------------------------------------------------------------
${loadBlock(ds)}

features = [${ds.features.map((f) => pyLiteral(f)).join(", ")}]
target = ${pyLiteral(ds.target)}

X = df[features].values
y = df[target].values

# -- pipeline (exactly what the extension ran) ---------------------------
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

model = ${cls}(${params})

scores = cross_val_score(model, X_scaled, y, cv=${ds.cvFolds}, scoring="${scoring}")
print(f"cv ${scoring}: {scores.mean():.4f} \\u00b1 {scores.std():.4f}")

model.fit(X_scaled, y)
joblib.dump(
    {"model": model, "scaler": scaler, "features": features, "target": target},
    "${run.key}.joblib",
)
`;
}
