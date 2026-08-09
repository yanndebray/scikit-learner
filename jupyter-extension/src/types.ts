import type { ISignal } from '@lumino/signaling';

/* ------------------------------------------------------------------ *
 *  The vocabulary, in one framework-free place.                       *
 *                                                                     *
 *  Nothing in this file imports JupyterLab. That is deliberate: the   *
 *  session model and the runtime are ports of the VS Code extension's *
 *  src/session.ts and src/runner.ts, and keeping them ignorant of the *
 *  shell is what lets the two stay comparable line by line. The       *
 *  JupyterLab concepts (Token, SidePanel, SessionContext) live in     *
 *  tokens.ts, panel.tsx and kernel.ts.                                *
 * ------------------------------------------------------------------ */

export const PluginIDs = {
  runtime: 'scikit-learner-jupyter:runtime',
  panel: 'scikit-learner-jupyter:panel',
  commands: 'scikit-learner-jupyter:commands',
  plots: 'scikit-learner-jupyter:plots',
  statusbar: 'scikit-learner-jupyter:statusbar',
  launcher: 'scikit-learner-jupyter:launcher'
} as const;

/** The ISettingRegistry plugin id. Must equal schema/plugin.json's filename
 *  stem prefixed by the npm package name: schema/plugin.json → ':plugin'. */
export const SETTINGS_PLUGIN_ID = 'scikit-learner-jupyter:plugin';

export const PANEL_ID = 'scikit-learner-jupyter:panel';
export const PLOTS_ID = 'scikit-learner-jupyter:plots';
export const PANEL_CLASS = 'sklearner-Panel';
export const PLOTS_CLASS = 'sklearner-Plots';

/* ============================== commands ============================ */

/** One per VS Code command, same order as the extension's package.json, so
 *  the two contribution lists can be diffed against each other. */
export const CommandIDs = {
  openPlots: 'scikit-learner:open-plots',
  chooseDataset: 'scikit-learner:choose-dataset',
  loadSample: 'scikit-learner:load-sample',
  loadCsv: 'scikit-learner:load-csv',
  setTarget: 'scikit-learner:set-target',
  selectFeatures: 'scikit-learner:select-features',
  setTask: 'scikit-learner:set-task',
  setValidation: 'scikit-learner:set-validation',
  trainSelected: 'scikit-learner:train-selected',
  trainAll: 'scikit-learner:train-all',
  selectRun: 'scikit-learner:select-run',
  /** Applies a gate's own suggested fix — currently only dropping the
   *  identifier-like columns G-LEAK-ID found. */
  applyGateFix: 'scikit-learner:apply-gate-fix',
  /** Answers a `decide` gate by taking one of its options. */
  answerGate: 'scikit-learner:answer-gate',
  exportRun: 'scikit-learner:export-run',
  openPipeline: 'scikit-learner:open-pipeline',
  openMetrics: 'scikit-learner:open-metrics',
  /** Not in the VS Code contribution list: there the plots editor's "Save
   *  PNG" is a webview message handled inline, because a save dialog is not
   *  a command. Here it has to be one, so the plots iframe can reach it. */
  savePlot: 'scikit-learner:save-plot',
  installPackages: 'scikit-learner:install-packages',
  /** The counterpart of VS Code's "Select Python interpreter…": which Python
   *  the models are fitted in. Here that is a kernelspec. */
  selectKernel: 'scikit-learner:select-kernel',
  restartRuntime: 'scikit-learner:restart-runtime',
  showLog: 'scikit-learner:show-log'
} as const;

export type CommandID = (typeof CommandIDs)[keyof typeof CommandIDs];

/* ============================ the model ============================= */

export type TaskType = 'regression' | 'classification';

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
  source: 'sample' | 'file';
  sampleKey?: string;
  /** Contents-manager path, not a filesystem path — in JupyterLite the file
   *  lives in the browser and has no fsPath to speak of. */
  filePath?: string;
  rows: number;
  columns: string[];
  numericColumns: string[];
  taskType: TaskType;
  target: string | null;
  features: string[];
  cvFolds: number;
}

/* ---- methodology gates ---------------------------------------------- *
 * Mirrors learner.py's run_gates(). `leak` means a reported number is
 * wrong, `decide` is a modelling choice the app has been making silently,
 * `note` is worth knowing and never blocks. */

export type GateSeverity = 'leak' | 'decide' | 'note';

export interface GateOption {
  key: string;
  label: string;
  recommended?: boolean;
}

export interface Gate {
  id: string;
  severity: GateSeverity;
  title: string;
  detail: string;
  columns?: { column: string; why: string }[];
  options?: GateOption[];
  /** Present when the gate can be resolved without asking anything. */
  fix?: { action: string; features?: string[] };
  models?: string[];
}

export interface GateReport {
  gates: Gate[];
  counts: Record<GateSeverity, number>;
  ready: boolean;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RunDetails {
  predictions: (number | string)[];
  actual: (number | string)[];
  residuals?: number[];
  confusion?: number[][];
  roc?: unknown;
  classLabels?: (number | string)[];
}

export interface Run {
  /** Model key — one run per key; retraining replaces it. */
  key: string;
  name: string;
  category: string;
  status: RunStatus;
  /** learner.py's model_id, once trained. */
  modelId?: string;
  metrics?: Record<string, number>;
  error?: string;
  fitSeconds?: number;
  trainedAt?: number;
  details?: RunDetails;
  /** Set once the joblib has been written, so ARTIFACTS can show its size. */
  exportedBytes?: number;
  /** Contents path the joblib was written to. */
  exportedPath?: string;
}

/** Sample datasets, mirroring ALL_DATASETS in the web app and SAMPLES in the
 *  VS Code extension. Kept as a literal rather than read from
 *  learner.list_samples() so the picker works before a kernel exists. */
export const SAMPLES = [
  { key: 'iris', name: 'Iris Flowers', task: 'classification', detail: '150 samples · 4 features' },
  { key: 'airfoil', name: 'Airfoil Self-Noise', task: 'regression', detail: '1503 samples · 5 features' },
  { key: 'wine', name: 'Wine Quality', task: 'classification', detail: '178 samples · 13 features' },
  { key: 'diabetes', name: 'Diabetes', task: 'regression', detail: '442 samples · 10 features' },
  { key: 'breast_cancer', name: 'Breast Cancer', task: 'classification', detail: '569 samples · 30 features' },
  { key: 'boston', name: 'Boston Housing (synthetic)', task: 'regression', detail: '506 samples · 12 features' },
  { key: 'digits', name: 'Digits', task: 'classification', detail: '1797 samples · 64 features' },
  { key: 'synthetic', name: 'Synthetic Regression', task: 'regression', detail: '500 samples · 5 features' }
] as const;

/** The metric a task is ranked by — the one the RUNS list, the status bar
 *  and bestRun() all agree on. */
export function rankMetric(task: TaskType | undefined): string {
  return task === 'classification' ? 'cv_accuracy_mean' : 'cv_r2_mean';
}

/* ============================== runtime ============================= */

/** Mirrors RuntimeStatus in the VS Code extension, with one state added:
 *  there, a missing scikit-learn is fixed by provisioning an environment
 *  before the process starts; here the kernel already exists and the fix is
 *  an install into it, which is a state the user can see and act on. */
export type RuntimeStatus =
  | { state: 'idle'; message: string }
  | { state: 'starting'; message: string }
  | { state: 'needs-packages'; message: string; missing: string[] }
  | { state: 'ready'; detail: string }
  | { state: 'failed'; message: string };

export interface RuntimeVersions {
  python?: string;
  sklearn?: string;
  pandas?: string;
  kernel?: string;
}

export interface CallResult {
  result?: unknown;
  /** base64 payload for bytes-returning functions (export_model, bulk_zip). */
  bin?: string;
}

/** learner.py raised ValueError — a message meant for the UI, not the log. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
    /* Harmless at ES2020, required if the target is ever lowered. */
    Object.setPrototypeOf(this, UserError.prototype);
  }
}

export type KernelSupplier = () => Promise<KernelHandle>;

/** A kernel, described structurally so runtime.ts never imports a
 *  SessionContext and session.ts never imports the execute protocol.
 *  src/kernel.ts adapts a real Kernel.IKernelConnection to it. */
export interface KernelHandle {
  readonly id: string;
  /** e.g. 'Python 3 (ipykernel)' or 'Python (Pyodide)'. */
  readonly displayName: string;
  /** Kernelspec language; the runtime refuses anything but 'python'. */
  readonly language: string;
  readonly isDisposed: boolean;
  execute(code: string, options?: KernelExecOptions): Promise<KernelExecOutcome>;
  interrupt(): Promise<void>;
}

export interface KernelExecOptions {
  /** Stream chunks as they arrive. NOT line-delimited — buffer and split on
   *  '\n' yourself before looking for the runner's '::' progress prefix. */
  onStream?(name: 'stdout' | 'stderr', text: string): void;
  signal?: AbortSignal;
}

export interface KernelExecOutcome {
  status: 'ok' | 'error' | 'abort';
  /** The application/json bundle off execute_result or display_data — a real
   *  object, never a parsed repr. */
  json: unknown | null;
  stdout: string;
  stderr: string;
  error: { ename: string; evalue: string; traceback: string[] } | null;
}

/** What learner_runner.probe() reports. */
export interface KernelProbe {
  platform: string;
  /** sys.platform === 'emscripten' — decides piplite versus %pip. */
  pyodide: boolean;
  python: string;
  missing: string[];
  /** Distribution names for `missing`, e.g. sklearn → scikit-learn. */
  install: string[];
  versions: Record<string, string>;
  booted: boolean;
}

/* ============================== settings ============================ */

export interface LearnerSettings {
  /** Kernelspec name for Scikit-Learner's own session. '' = server default. */
  kernelName: string;
  /** Install the missing packages into the kernel without asking. Off by
   *  default in JupyterLab, where the kernel is the user's environment and a
   *  silent pip install into it is not ours to make. */
  autoInstall: boolean;
  /** Cross-validation folds a freshly loaded dataset starts on. */
  cvFolds: number;
  /** Directory the generated pipeline.py, metrics.json and .joblib files are
   *  written to, relative to the contents root. '' = alongside the dataset. */
  outputDir: string;
}

/** schema/plugin.json must mirror this key-for-key and default-for-default.
 *  Divergence is silent and shows up as "the setting does nothing". */
export const DEFAULT_SETTINGS: LearnerSettings = {
  kernelName: '',
  autoInstall: false,
  cvFolds: 5,
  outputDir: 'scikit-learner'
};

export interface LearnerSettingsSource {
  readonly current: LearnerSettings;
  readonly changed: ISignal<LearnerSettingsSource, LearnerSettings>;
  set<K extends keyof LearnerSettings>(key: K, value: LearnerSettings[K]): Promise<void>;
}
