import type { Contents } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';

import { readBase64 } from './contents.js';
import { log } from './log.js';
import { rankMetric, UserError } from './types.js';
import type {
  CatalogModel,
  DatasetInfo,
  GateReport,
  LearnerSettingsSource,
  Run,
  TaskType
} from './types.js';
import type { LearnerRuntime } from './runtime.js';

/* ------------------------------------------------------------------ *
 *  The session model.                                                 *
 *                                                                     *
 *  A port of the VS Code extension's src/session.ts, and deliberately *
 *  a close one — the two files should stay diffable. Same reasoning   *
 *  applies here as there: in the 0.1.x web app the view WAS the app,  *
 *  and the 0.2.0 redesign moved the state into a model so that every  *
 *  native surface is a pure renderer of it. There those surfaces are  *
 *  tree views, a status bar and a webview; here they are accordion    *
 *  sections, a status bar item and an iframe. The model does not know *
 *  the difference.                                                    *
 *                                                                     *
 *  learner.py still holds the Python half — the dataframe and the     *
 *  fitted models, in kernel module state. This class mirrors what the *
 *  UI needs and stays in sync by being the only caller.               *
 *                                                                     *
 *  Three JupyterLab facts leak in and are worth naming:               *
 *                                                                     *
 *   - Paths are contents-manager paths, not filesystem paths. In      *
 *     JupyterLite they name something in IndexedDB.                   *
 *   - One coarse `changed` signal; renderers re-read the whole model. *
 *     It is small, and Lumino coalesces the repaints.                 *
 *   - Training is a loop of awaits with a signal fired between each,  *
 *     exactly as in VS Code. The kernel is single-threaded, so the    *
 *     queue is real rather than a UI affectation.                     *
 * ------------------------------------------------------------------ */

export interface LearnerSessionOptions {
  runtime: LearnerRuntime;
  settings: LearnerSettingsSource;
  contents: Contents.IManager;
}

export class LearnerSession implements IDisposable {
  dataset: DatasetInfo | null = null;
  /** Full catalog for the active task type, flat, with category on each. */
  catalog: CatalogModel[] = [];
  readonly selected = new Set<string>();
  runs: Run[] = [];
  selectedRunKey: string | null = null;
  training = false;
  /** Model keys in the currently running training queue (status bar). */
  queue: string[] = [];
  /** First 1000 rows of each numeric column — feeds the scatter tab. */
  preview: { columns: string[]; data: Record<string, number[]> } | null = null;
  /** What the methodology gates last said. Recomputed on every change that
   *  could alter the answer — the dataset, the target, the features, the
   *  task, the fold count. Cheap: it is arithmetic over a dataframe. */
  gates: GateReport = { gates: [], counts: { leak: 0, decide: 0, note: 0 }, ready: false };

  /** One coarse event; renderers re-read the whole model. */
  readonly changed = new Signal<LearnerSession, void>(this);

  constructor(private readonly _options: LearnerSessionOptions) {}

  get runtime(): LearnerRuntime {
    return this._options.runtime;
  }

  get contents(): Contents.IManager {
    return this._options.contents;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  bestRun(): Run | undefined {
    const metric = rankMetric(this.dataset?.taskType);
    return this.runs
      .filter(r => r.status === 'done')
      .reduce<Run | undefined>(
        (best, r) =>
          (r.metrics?.[metric] ?? -Infinity) > (best?.metrics?.[metric] ?? -Infinity) ? r : best,
        undefined
      );
  }

  selectedRun(): Run | undefined {
    return this.runs.find(r => r.key === this.selectedRunKey);
  }

  run(key: string): Run | undefined {
    return this.runs.find(r => r.key === key);
  }

  model(key: string): CatalogModel | undefined {
    return this.catalog.find(m => m.key === key);
  }

  fire(): void {
    this.changed.emit();
  }

  /* ---- dataset ------------------------------------------------------ */

  async loadSample(sampleKey: string): Promise<void> {
    const result = (await this.runtime.call('load_sample', [sampleKey])).result as Record<
      string,
      unknown
    >;
    await this._ingest(result, { source: 'sample', sampleKey });
  }

  async loadFile(path: string): Promise<void> {
    const b64 = await readBase64(this.contents, path);
    const name = path.split('/').pop() ?? path;
    const result = (await this.runtime.call('upload_csv', [name], b64)).result as Record<
      string,
      unknown
    >;
    await this._ingest(result, { source: 'file', filePath: path });
  }

  private async _ingest(
    result: Record<string, unknown>,
    origin: { source: 'sample' | 'file'; sampleKey?: string; filePath?: string }
  ): Promise<void> {
    const numeric = (result.numeric_columns as string[]) ?? [];
    const target = numeric.includes('target') ? 'target' : numeric[numeric.length - 1] ?? null;
    this.dataset = {
      filename: result.filename as string,
      source: origin.source,
      sampleKey: origin.sampleKey,
      filePath: origin.filePath,
      rows: (result.stats as { rows: number } | undefined)?.rows ?? 0,
      columns: (result.columns as string[]) ?? [],
      numericColumns: numeric,
      taskType: (result.task_type as TaskType) ?? 'regression',
      target,
      features: numeric.filter(c => c !== target),
      cvFolds: this._options.settings.current.cvFolds
    };
    /* learner.py's _ingest_df cleared its models dict; mirror that. */
    this.runs = [];
    this.selectedRunKey = null;
    await this._refreshCatalog();
    await this._refreshPreview();
    await this.refreshGates();
    log.info(`dataset loaded: ${this.dataset.filename} (${this.dataset.rows} rows)`);
    this.fire();
  }

  private async _refreshCatalog(): Promise<void> {
    const task = this.dataset?.taskType ?? 'regression';
    const data = (await this.runtime.call('available_models', [task])).result as {
      models: Record<
        string,
        {
          key: string;
          name: string;
          params: Record<string, unknown>;
          class_name?: string;
          module?: string;
        }[]
      >;
    };
    this.catalog = Object.entries(data.models).flatMap(([category, models]) =>
      models.map(m => ({
        key: m.key,
        name: m.name,
        category,
        params: m.params,
        className: m.class_name,
        module: m.module
      }))
    );
    /* Selections carry over only where the key still exists (task switch). */
    for (const key of [...this.selected]) {
      if (!this.catalog.some(m => m.key === key)) {
        this.selected.delete(key);
      }
    }
  }

  private async _refreshPreview(): Promise<void> {
    try {
      const p = (await this.runtime.call('data_preview', [])).result as {
        columns: string[];
        data: Record<string, number[]>;
      };
      this.preview = { columns: p.columns, data: p.data };
    } catch (err) {
      log.warn(`data_preview failed: ${(err as Error).message}`);
      this.preview = null;
    }
  }

  setTarget(column: string): void {
    if (!this.dataset) {
      return;
    }
    this.dataset.target = column;
    this.dataset.features = this.dataset.numericColumns.filter(c => c !== column);
    this.fire();
    void this.refreshGates();
  }

  /** Re-run the deterministic checks. Never throws — a broken gate must not
   *  be able to stop you training a model. */
  async refreshGates(): Promise<void> {
    const ds = this.dataset;
    if (!ds) {
      this.gates = { gates: [], counts: { leak: 0, decide: 0, note: 0 }, ready: false };
      return;
    }
    try {
      const report = (
        await this.runtime.call('run_gates', [ds.features, ds.target, ds.taskType, ds.cvFolds])
      ).result as GateReport;
      this.gates = report;
    } catch (err) {
      log.warn(`run_gates failed: ${(err as Error).message}`);
      this.gates = { gates: [], counts: { leak: 0, decide: 0, note: 0 }, ready: false };
    }
    this.fire();
  }

  async setTask(task: TaskType): Promise<void> {
    if (!this.dataset || this.dataset.taskType === task) {
      return;
    }
    this.dataset.taskType = task;
    await this._refreshCatalog();
    this.fire();
    await this.refreshGates();
  }

  setCvFolds(folds: number): void {
    if (!this.dataset) {
      return;
    }
    this.dataset.cvFolds = folds;
    this.fire();
    void this.refreshGates();
  }

  setFeatures(features: string[]): void {
    if (!this.dataset) {
      return;
    }
    this.dataset.features = features;
    this.fire();
    void this.refreshGates();
  }

  toggleModel(key: string, on: boolean): void {
    if (on) {
      this.selected.add(key);
    } else {
      this.selected.delete(key);
    }
    this.fire();
  }

  /** Every model in a category on or off at once — the checkbox on the
   *  category row, which VS Code gets for free from tree-view tri-state and
   *  an accordion has to implement. */
  toggleCategory(category: string, on: boolean): void {
    for (const m of this.catalog) {
      if (m.category === category) {
        if (on) {
          this.selected.add(m.key);
        } else {
          this.selected.delete(m.key);
        }
      }
    }
    this.fire();
  }

  /* ---- training ------------------------------------------------------ */

  async train(keys: string[]): Promise<void> {
    const ds = this.dataset;
    if (!ds) {
      throw new UserError('Load a dataset first.');
    }
    if (!ds.target) {
      throw new UserError('Pick a target column first.');
    }
    if (ds.features.length === 0) {
      throw new UserError('Pick at least one feature.');
    }
    if (this.training) {
      throw new UserError('A training run is already in progress.');
    }
    const todo = keys
      .map(key => this.model(key))
      .filter((m): m is CatalogModel => m !== undefined);
    if (todo.length === 0) {
      throw new UserError('Select at least one model to train.');
    }

    this.training = true;
    this.queue = todo.map(m => m.key);
    /* Queue every requested model up front so the RUNS list shows the plan,
       not just what has finished. */
    for (const m of todo) {
      const existing = this.run(m.key);
      const fresh: Run = { key: m.key, name: m.name, category: m.category, status: 'queued' };
      if (existing) {
        Object.assign(existing, fresh, {
          metrics: undefined,
          details: undefined,
          error: undefined
        });
      } else {
        this.runs.push(fresh);
      }
    }
    this.fire();

    let trained = 0;
    try {
      for (const m of todo) {
        const run = this.run(m.key)!;
        run.status = 'running';
        this.fire();
        const started = Date.now();
        try {
          const result = (
            await this.runtime.call('train', [
              m.key,
              ds.features,
              ds.target,
              ds.cvFolds,
              ds.taskType
            ])
          ).result as Record<string, unknown>;
          run.modelId = result.model_id as string;
          run.metrics = result.metrics as Record<string, number>;
          run.fitSeconds = (Date.now() - started) / 1000;
          run.trainedAt = Date.now();
          run.status = 'done';
          trained += 1;
          const headline =
            ds.taskType === 'classification'
              ? `accuracy ${(run.metrics.accuracy ?? 0).toFixed(3)}`
              : `r2 ${(run.metrics.r2 ?? 0).toFixed(3)}`;
          log.info(
            `${m.name}  cv=${ds.cvFolds}  ${headline}  ${run.fitSeconds.toFixed(2)}s  ok`
          );
          await this._loadDetails(run);
        } catch (err) {
          run.status = 'failed';
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
        if (best && this.selectedRun()?.status !== 'done') {
          this.selectedRunKey = best.key;
        }
      }
      this.fire();
    }
  }

  private async _loadDetails(run: Run): Promise<void> {
    if (!run.modelId) {
      return;
    }
    const d = (await this.runtime.call('predictions', [run.modelId])).result as Record<
      string,
      never
    >;
    run.details = {
      predictions: d.predictions,
      actual: d.actual,
      residuals: d.residuals,
      confusion: d.confusion_matrix,
      roc: d.roc_curve,
      classLabels: d.class_labels
    };
  }

  selectRun(key: string): void {
    if (this.run(key)) {
      this.selectedRunKey = key;
      this.fire();
    }
  }

  /* ---- artifacts ------------------------------------------------------ */

  /** The joblib bytes for a run, base64 as they come off the kernel. Writing
   *  them is the caller's job — where a file goes is a shell decision. */
  async exportBytes(key: string): Promise<string> {
    const run = this.run(key);
    if (!run?.modelId) {
      throw new UserError("That model hasn't been trained yet.");
    }
    const { bin } = await this.runtime.call('export_model', [run.modelId]);
    if (!bin) {
      throw new Error('export_model returned no payload');
    }
    return bin;
  }

  noteExported(key: string, path: string, bytes: number): void {
    const run = this.run(key);
    if (!run) {
      return;
    }
    run.exportedPath = path;
    run.exportedBytes = bytes;
    this.fire();
  }

  /** Drop everything that lived in the kernel. The VS Code extension kills
   *  its Python process; here the kernel is shared with the user's own work,
   *  so only learner.py's namespace goes. */
  async reset(): Promise<void> {
    this.dataset = null;
    this.runs = [];
    this.selectedRunKey = null;
    this.selected.clear();
    this.preview = null;
    this.training = false;
    this.catalog = [];
    await this.runtime.reset();
    this.fire();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    Signal.clearData(this);
  }

  private _disposed = false;
}
