import * as path from "node:path";
import * as vscode from "vscode";
import { LearnerRuntime, UserError } from "./runner";
import { log } from "./util/log";

/* ------------------------------------------------------------------ */
/*  The session model.                                                 */
/*                                                                     */
/*  In the 0.1.x design the webview WAS the app: app.js held all UI    */
/*  state. The 0.2.0 redesign (issue #17) moves the state here so      */
/*  native surfaces — tree views, status bar, the plots webview — are  */
/*  all pure renderers of one model. learner.py still holds the        */
/*  Python half (dataframe, fitted models); this class mirrors what    */
/*  the UI needs and stays in sync by being the only caller.           */
/* ------------------------------------------------------------------ */

export type TaskType = "regression" | "classification";

export interface CatalogModel {
  key: string;
  name: string;
  category: string;
  params: Record<string, unknown>;
  className?: string;
  module?: string;
}

export interface DatasetInfo {
  filename: string;
  source: "sample" | "file";
  sampleKey?: string;
  fileUri?: vscode.Uri;
  rows: number;
  columns: string[];
  numericColumns: string[];
  taskType: TaskType;
  target: string | null;
  features: string[];
  cvFolds: number;
}

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface Run {
  key: string; // model key — one run per key; retraining replaces it
  name: string;
  category: string;
  status: RunStatus;
  modelId?: string; // learner.py model_id once trained
  metrics?: Record<string, number>;
  error?: string;
  fitSeconds?: number;
  trainedAt?: number;
  details?: {
    predictions: (number | string)[];
    actual: (number | string)[];
    residuals?: number[];
    confusion?: number[][];
    roc?: unknown;
    classLabels?: (number | string)[];
  };
  exportedBytes?: number;
}

/** Sample datasets, mirroring ALL_DATASETS in the web app. */
export const SAMPLES = [
  { key: "iris", name: "Iris Flowers", task: "classification", detail: "150 samples · 4 features" },
  { key: "airfoil", name: "Airfoil Self-Noise", task: "regression", detail: "1503 samples · 5 features" },
  { key: "wine", name: "Wine Quality", task: "classification", detail: "178 samples · 13 features" },
  { key: "diabetes", name: "Diabetes", task: "regression", detail: "442 samples · 10 features" },
  { key: "breast_cancer", name: "Breast Cancer", task: "classification", detail: "569 samples · 30 features" },
  { key: "boston", name: "Boston Housing (synthetic)", task: "regression", detail: "506 samples · 12 features" },
  { key: "digits", name: "Digits", task: "classification", detail: "1797 samples · 64 features" },
  { key: "synthetic", name: "Synthetic Regression", task: "regression", detail: "500 samples · 5 features" },
] as const;

export class Session implements vscode.Disposable {
  readonly runtime: LearnerRuntime;

  dataset: DatasetInfo | null = null;
  /** Full catalog for the active task type, flat, with category on each entry. */
  catalog: CatalogModel[] = [];
  readonly selected = new Set<string>();
  runs: Run[] = [];
  selectedRunKey: string | null = null;
  training = false;
  /** Model keys in the currently running training queue (status bar). */
  queue: string[] = [];
  /** First 1000 rows of each numeric column — feeds the scatter tab. */
  preview: { columns: string[]; data: Record<string, number[]> } | null = null;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** One coarse event; renderers re-read the whole model. It is small. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.runtime = new LearnerRuntime(context);
  }

  private fire(): void {
    this.changeEmitter.fire();
  }

  bestRun(): Run | undefined {
    const metric = this.dataset?.taskType === "classification" ? "cv_accuracy_mean" : "cv_r2_mean";
    return this.runs
      .filter((r) => r.status === "done")
      .reduce<Run | undefined>(
        (best, r) =>
          (r.metrics?.[metric] ?? -Infinity) > (best?.metrics?.[metric] ?? -Infinity) ? r : best,
        undefined
      );
  }

  selectedRun(): Run | undefined {
    return this.runs.find((r) => r.key === this.selectedRunKey);
  }

  run(key: string): Run | undefined {
    return this.runs.find((r) => r.key === key);
  }

  /* ---- dataset ------------------------------------------------------ */

  async loadSample(sampleKey: string): Promise<void> {
    const result = (await this.runtime.call("load_sample", [sampleKey])).result as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    await this.ingest(result, { source: "sample", sampleKey });
  }

  async loadFile(uri: vscode.Uri): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const name = path.basename(uri.fsPath);
    const result = (
      await this.runtime.call("upload_csv", [name], Buffer.from(bytes).toString("base64"))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).result as Record<string, any>;
    await this.ingest(result, { source: "file", fileUri: uri });
  }

  private async ingest(
    result: Record<string, unknown>,
    origin: { source: "sample" | "file"; sampleKey?: string; fileUri?: vscode.Uri }
  ): Promise<void> {
    const numeric = result.numeric_columns as string[];
    const target = numeric.includes("target") ? "target" : numeric[numeric.length - 1] ?? null;
    this.dataset = {
      filename: result.filename as string,
      source: origin.source,
      sampleKey: origin.sampleKey,
      fileUri: origin.fileUri,
      rows: (result.stats as { rows: number }).rows,
      columns: result.columns as string[],
      numericColumns: numeric,
      taskType: (result.task_type as TaskType) ?? "regression",
      target,
      features: numeric.filter((c) => c !== target),
      cvFolds: 5,
    };
    /* learner.py's _ingest_df cleared its models dict; mirror that. */
    this.runs = [];
    this.selectedRunKey = null;
    await this.refreshCatalog();
    await this.refreshPreview();
    log.info(`dataset loaded: ${this.dataset.filename} (${this.dataset.rows} rows)`);
    this.fire();
  }

  private async refreshCatalog(): Promise<void> {
    const task = this.dataset?.taskType ?? "regression";
    const data = (await this.runtime.call("available_models", [task])).result as {
      models: Record<
        string,
        { key: string; name: string; params: Record<string, unknown>; class_name?: string; module?: string }[]
      >;
    };
    this.catalog = Object.entries(data.models).flatMap(([category, models]) =>
      models.map((m) => ({
        key: m.key,
        name: m.name,
        category,
        params: m.params,
        className: m.class_name,
        module: m.module,
      }))
    );
    /* Selections carry over only where the key still exists (task switch). */
    for (const key of [...this.selected]) {
      if (!this.catalog.some((m) => m.key === key)) this.selected.delete(key);
    }
  }

  private async refreshPreview(): Promise<void> {
    try {
      const p = (await this.runtime.call("data_preview", [])).result as {
        columns: string[];
        data: Record<string, number[]>;
      };
      this.preview = { columns: p.columns, data: p.data };
    } catch (err) {
      log.warn(`data_preview failed: ${(err as Error).message}`);
      this.preview = null;
    }
  }

  async setTarget(column: string): Promise<void> {
    if (!this.dataset) return;
    this.dataset.target = column;
    this.dataset.features = this.dataset.numericColumns.filter((c) => c !== column);
    this.fire();
  }

  async setTask(task: TaskType): Promise<void> {
    if (!this.dataset || this.dataset.taskType === task) return;
    this.dataset.taskType = task;
    await this.refreshCatalog();
    this.fire();
  }

  setCvFolds(folds: number): void {
    if (!this.dataset) return;
    this.dataset.cvFolds = folds;
    this.fire();
  }

  setFeatures(features: string[]): void {
    if (!this.dataset) return;
    this.dataset.features = features;
    this.fire();
  }

  toggleModel(key: string, on: boolean): void {
    if (on) this.selected.add(key);
    else this.selected.delete(key);
    this.fire();
  }

  /* ---- training ------------------------------------------------------ */

  async train(keys: string[]): Promise<void> {
    const ds = this.dataset;
    if (!ds) throw new UserError("Load a dataset first.");
    if (!ds.target) throw new UserError("Pick a target column first.");
    if (ds.features.length === 0) throw new UserError("Pick at least one feature.");
    if (this.training) throw new UserError("A training run is already in progress.");
    const todo = keys.map((key) => this.catalog.find((m) => m.key === key)).filter(Boolean) as CatalogModel[];
    if (todo.length === 0) throw new UserError("Select at least one model to train.");

    this.training = true;
    this.queue = todo.map((m) => m.key);
    /* Queue every requested model up front so the runs tree shows the plan. */
    for (const m of todo) {
      const existing = this.run(m.key);
      const fresh: Run = { key: m.key, name: m.name, category: m.category, status: "queued" };
      if (existing) Object.assign(existing, fresh, { metrics: undefined, details: undefined, error: undefined });
      else this.runs.push(fresh);
    }
    this.fire();

    let trained = 0;
    try {
      for (const m of todo) {
        const run = this.run(m.key)!;
        run.status = "running";
        this.fire();
        const started = Date.now();
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = (
            await this.runtime.call("train", [m.key, this.dataset!.features, this.dataset!.target, this.dataset!.cvFolds, this.dataset!.taskType])
          ).result as Record<string, any>;
          run.modelId = result.model_id as string;
          run.metrics = result.metrics as Record<string, number>;
          run.fitSeconds = (Date.now() - started) / 1000;
          run.trainedAt = Date.now();
          run.status = "done";
          trained += 1;
          const metric =
            this.dataset!.taskType === "classification"
              ? `accuracy ${(run.metrics.accuracy ?? 0).toFixed(3)}`
              : `r2 ${(run.metrics.r2 ?? 0).toFixed(3)}`;
          log.info(`${m.name}  cv=${this.dataset!.cvFolds}  ${metric}  ${run.fitSeconds.toFixed(2)}s  ok`);
          await this.loadDetails(run);
        } catch (err) {
          run.status = "failed";
          run.error = (err as Error).message;
          log.warn(`${m.name} failed: ${run.error}`);
        }
        this.fire();
      }
    } finally {
      this.training = false;
      this.queue = [];
      if (trained > 0) {
        const best = this.bestRun();
        if (best && (!this.selectedRun() || this.selectedRun()?.status !== "done")) {
          this.selectedRunKey = best.key;
        }
      }
      this.fire();
    }
  }

  private async loadDetails(run: Run): Promise<void> {
    if (!run.modelId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (await this.runtime.call("predictions", [run.modelId])).result as Record<string, any>;
    run.details = {
      predictions: d.predictions,
      actual: d.actual,
      residuals: d.residuals,
      confusion: d.confusion_matrix,
      roc: d.roc_curve,
      classLabels: d.class_labels,
    };
  }

  selectRun(key: string): void {
    if (this.run(key)) {
      this.selectedRunKey = key;
      this.fire();
    }
  }

  /* ---- artifacts ------------------------------------------------------ */

  async exportRun(key: string): Promise<vscode.Uri | undefined> {
    const run = this.run(key);
    if (!run?.modelId) throw new UserError("That model hasn't been trained yet.");
    const r = await this.runtime.call("export_model", [run.modelId]);
    if (!r.bin) throw new Error("export_model returned no payload");
    const bytes = Buffer.from(r.bin, "base64");
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const suggested = `${run.key}.joblib`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, suggested) : vscode.Uri.file(suggested),
      title: "Export model (joblib)",
    });
    if (!target) return undefined;
    await vscode.workspace.fs.writeFile(target, bytes);
    run.exportedBytes = bytes.length;
    this.fire();
    return target;
  }

  /** Restart Python and drop everything that lived in that process. */
  async reset(): Promise<void> {
    this.dataset = null;
    this.runs = [];
    this.selectedRunKey = null;
    this.selected.clear();
    this.preview = null;
    this.training = false;
    await this.runtime.restart();
    this.fire();
  }

  dispose(): void {
    this.runtime.dispose();
    this.changeEmitter.dispose();
  }
}
