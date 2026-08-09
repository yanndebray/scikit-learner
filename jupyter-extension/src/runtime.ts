import { Signal } from '@lumino/signaling';

import { AIRFOIL_CSV, LEARNER_SOURCE, RUNNER_SOURCE } from './generated/assets.js';
import { base64Utf8, forgetArmed, isArmed, markArmed } from './kernel.js';
import { log } from './log.js';
import { UserError } from './types.js';
import type {
  CallResult,
  KernelExecOutcome,
  KernelHandle,
  KernelProbe,
  KernelSupplier,
  LearnerSettingsSource,
  RuntimeStatus,
  RuntimeVersions
} from './types.js';

/* ------------------------------------------------------------------ *
 *  The Python runtime.                                                *
 *                                                                     *
 *  A port of the VS Code extension's src/runner.ts, transport swapped *
 *  and one step added. There, `ensureStarted` finds an interpreter    *
 *  with scikit-learn, spawns it and waits for a ready handshake. Here *
 *  the kernel already exists, so the same sequence becomes:           *
 *                                                                     *
 *      arm    push learner_runner.py into the kernel and exec it      *
 *      probe  ask it what this Python is and what it is missing       *
 *      fix    install the missing packages, when we are allowed to    *
 *      boot   push learner.py and exec it into a namespace            *
 *                                                                     *
 *  The order is the point. Arming is a few kB and tells us whether we *
 *  can talk to this kernel at all; the probe costs nothing; only once *
 *  both have passed do we push learner.py and the bundled CSV, which  *
 *  together are ~120 kB of base64 down one websocket message.         *
 *                                                                     *
 *  Same strict rule as the other two hosts: stdout is a protocol,     *
 *  stderr is a log. Responses arrive as an application/json display   *
 *  bundle; anything the runner prefixes with `::` on stderr is        *
 *  progress and is surfaced live.                                     *
 * ------------------------------------------------------------------ */

/** Must match learner_runner.SENTINEL. Only used where IPython.display is
 *  missing, which no shipping kernel we know of hits — it exists so that an
 *  unfamiliar kernel degrades to something parseable instead of silence. */
const SENTINEL = '@@SCIKIT-LEARNER-JSON@@';

const MODULE = '_sklearner_runner';

/* The kernel's environment is routinely not the server's, so
   `import scikit_learner_jupyter.runner` would work on the author's laptop
   and fail for half the users. The source travels with the bundle instead and
   is exec'd into a module object once per kernel — which is also why the
   Pyodide path needs nothing installed to get this far. */
const ARM_CODE = `
import base64 as _skl_b64, sys as _skl_sys, types as _skl_types
_skl_src = _skl_b64.b64decode("${base64Utf8(RUNNER_SOURCE)}").decode("utf-8")
_skl_mod = _skl_types.ModuleType("${MODULE}")
_skl_mod.__file__ = "<learner_runner.py>"
exec(compile(_skl_src, "<learner_runner.py>", "exec"), _skl_mod.__dict__)
_skl_sys.modules["${MODULE}"] = _skl_mod
del _skl_b64, _skl_sys, _skl_types, _skl_src, _skl_mod
`;

function dispatchCode(request: unknown): string {
  /* The request goes over as one ASCII string literal: a CSV full of quotes,
     backslashes and newlines has no way out of it, and neither does a column
     name someone typed in a spreadsheet. */
  return `import ${MODULE} as _skl\n_skl.dispatch("${base64Utf8(JSON.stringify(request))}")\n`;
}

interface RunnerEnvelope {
  id?: number | null;
  ok?: boolean;
  result?: unknown;
  bin?: string;
  error?: string;
  user?: boolean;
}

/** Pull the response out of an execution: the JSON bundle if the kernel sent
 *  one, otherwise the sentinel line on stdout. */
function envelopeOf(outcome: KernelExecOutcome): RunnerEnvelope | null {
  if (outcome.json && typeof outcome.json === 'object') {
    return outcome.json as RunnerEnvelope;
  }
  const at = outcome.stdout.lastIndexOf(SENTINEL);
  if (at < 0) {
    return null;
  }
  const line = outcome.stdout.slice(at + SENTINEL.length).split('\n', 1)[0];
  try {
    return JSON.parse(line) as RunnerEnvelope;
  } catch {
    return null;
  }
}

export interface RuntimeOptions {
  kernel: KernelSupplier;
  settings: LearnerSettingsSource;
}

/** Asks the user whether to install into their kernel. Resolves true to go
 *  ahead. Supplied by the shell, because a dialog is a shell's business —
 *  this module has to stay runnable with no UI at all. */
export type InstallPrompt = (probe: KernelProbe) => Promise<boolean>;

export class LearnerRuntime {
  readonly statusChanged = new Signal<LearnerRuntime, RuntimeStatus>(this);
  /** One line the runner wrote to stderr behind `::`. The status bar shows
   *  the latest; the log keeps all of them. */
  readonly progress = new Signal<LearnerRuntime, string>(this);

  /** Versions reported by probe() — for the status bar tooltip. */
  versions: RuntimeVersions = {};

  constructor(private readonly _options: RuntimeOptions) {}

  /** Register the consent dialog. Without one, a kernel that is missing
   *  packages stops at `needs-packages` and waits for the command — which is
   *  what happens on a front end that has no dialogs to show. */
  setInstallPrompt(prompt: InstallPrompt | null): void {
    this._prompt = prompt;
  }

  status(): RuntimeStatus {
    return this._status;
  }

  /** What the last probe found, or null before the first one. */
  get probe(): KernelProbe | null {
    return this._probe;
  }

  /** Start (or join the in-flight start of) the runtime. Idempotent. */
  ensureReady(): Promise<KernelHandle> {
    this._readying ??= this._prepare().catch(err => {
      /* A failed start can be retried — the user may have just installed the
         thing it complained about. */
      this._readying = null;
      throw err;
    });
    return this._readying;
  }

  /**
   * Call a top-level learner.py function.
   *
   * `bufB64` is prepended by the runner as bytes — the upload_csv path,
   * mirroring pyCallBinary in the web app and the `buf` field in the VS Code
   * extension's stdio protocol.
   */
  async call(fn: string, args: unknown[] = [], bufB64?: string): Promise<CallResult> {
    const kernel = await this.ensureReady();
    return this._dispatch(kernel, { id: this._nextId++, kind: 'call', fn, args, buf: bufB64 ?? null });
  }

  /** Install what the probe said was missing. Separate from ensureReady so it
   *  can also be a command, which is how a user answers "not now" and then
   *  changes their mind. */
  async installPackages(): Promise<void> {
    const kernel = await this._options.kernel();
    const probe = this._probe ?? (await this._runProbe(kernel));
    if (probe.missing.length === 0) {
      return;
    }
    await this._install(kernel, probe);
    /* Everything downstream of the install has to be redone against the new
       set of importable packages. */
    this._probe = null;
    this._readying = null;
  }

  /** Throw away learner.py's dataframe and fitted models without disturbing
   *  anything else in the kernel. */
  async reset(): Promise<void> {
    if (!this._probe?.booted) {
      this._readying = null;
      return;
    }
    try {
      const kernel = await this._options.kernel();
      await this._dispatch(kernel, { id: this._nextId++, kind: 'reset' });
    } catch (err) {
      log.warn(`reset failed: ${(err as Error).message}`);
    }
    this._probe = null;
    this._readying = null;
    this._report({ state: 'idle', message: 'Not started.' });
  }

  /** Called by the owner when the kernel restarted under us. */
  forget(): void {
    this._probe = null;
    this._readying = null;
    this.versions = {};
    this._report({ state: 'idle', message: 'Not started.' });
  }

  /* ---- the sequence ---------------------------------------------------- */

  private async _prepare(): Promise<KernelHandle> {
    this._report({ state: 'starting', message: 'Starting the kernel…' });
    const kernel = await this._options.kernel();

    /* A kernelspec whose language is not python cannot run any of this, and
       the failure it would produce (SyntaxError inside the arm step) says
       nothing useful. Empty means the spec request has not landed; that is
       not evidence of anything, so it passes. */
    if (kernel.language && kernel.language !== 'python') {
      const message = `${kernel.displayName} is not a Python kernel, so it cannot fit scikit-learn models.`;
      this._report({ state: 'failed', message });
      throw new UserError(message);
    }

    await this._arm(kernel);

    this._report({ state: 'starting', message: 'Checking the kernel for scikit-learn…' });
    let probe = await this._runProbe(kernel);

    if (probe.missing.length > 0) {
      /* Pyodide's kernel is per-tab and disposable, and its packages are a
         download rather than a change to anything the user owns, so
         installing into it is not a decision worth interrupting for. A
         JupyterLab kernel is somebody's real environment. */
      let mayInstall = probe.pyodide || this._options.settings.current.autoInstall;

      /* Asked here rather than after the failure, so the answer continues the
         sequence instead of making the user repeat what they just did. This
         is the shape of the VS Code extension's readyInterpreter(): the
         environment question arrives when Python is first needed, with the
         fix attached, and the original action carries on afterwards. */
      if (!mayInstall && this._prompt) {
        const message = `${kernel.displayName} is missing ${probe.install.join(', ')}.`;
        this._report({ state: 'needs-packages', message, missing: probe.install });
        mayInstall = await this._prompt(probe);
      }

      if (!mayInstall) {
        const message =
          `${kernel.displayName} is missing ${probe.install.join(', ')}. ` +
          'Run “Scikit-Learner: Install missing packages into the kernel”.';
        this._report({ state: 'needs-packages', message, missing: probe.install });
        throw new UserError(message);
      }
      await this._install(kernel, probe);
      probe = await this._runProbe(kernel);
      if (probe.missing.length > 0) {
        const message = `Installing ${probe.install.join(', ')} into ${kernel.displayName} did not take.`;
        this._report({ state: 'failed', message });
        throw new Error(message);
      }
    }

    if (!probe.booted) {
      this._report({ state: 'starting', message: 'Loading scikit-learn…' });
      await this._boot(kernel);
      probe = await this._runProbe(kernel);
    }

    this.versions = {
      python: probe.python,
      sklearn: probe.versions.sklearn,
      pandas: probe.versions.pandas,
      kernel: kernel.displayName
    };
    const detail = `${kernel.displayName} · Python ${probe.python}`;
    this._report({ state: 'ready', detail });
    log.info(`runtime ready: ${detail}${probe.versions.sklearn ? ` · scikit-learn ${probe.versions.sklearn}` : ''}`);
    return kernel;
  }

  private async _arm(kernel: KernelHandle): Promise<void> {
    if (isArmed(kernel.id)) {
      return;
    }
    const outcome = await kernel.execute(ARM_CODE);
    if (outcome.status !== 'ok') {
      forgetArmed(kernel.id);
      const why = outcome.error ? `${outcome.error.ename}: ${outcome.error.evalue}` : outcome.status;
      const message = `Could not load the Scikit-Learner runner into ${kernel.displayName} (${why}).`;
      this._report({ state: 'failed', message });
      throw new Error(message);
    }
    markArmed(kernel.id);
    log.debug(`runner armed in ${kernel.displayName}`);
  }

  private async _runProbe(kernel: KernelHandle): Promise<KernelProbe> {
    await this._arm(kernel);
    const { result } = await this._dispatch(kernel, { id: this._nextId++, kind: 'probe' });
    const probe = result as KernelProbe;
    this._probe = probe;
    return probe;
  }

  private async _install(kernel: KernelHandle, probe: KernelProbe): Promise<void> {
    const packages = probe.install;
    this._report({
      state: 'starting',
      message: `Installing ${packages.join(', ')} into ${kernel.displayName}…`
    });
    log.info(`installing ${packages.join(', ')} into ${kernel.displayName}`);

    const list = packages.map(name => JSON.stringify(name)).join(', ');
    /* Two Pythons, two package managers. piplite is the Pyodide kernel's own
       installer and is a coroutine, which is fine because that kernel runs
       every cell under top-level await. Everywhere else %pip is the one thing
       guaranteed to target the kernel's interpreter rather than the server's
       — `pip` on PATH frequently is not the same Python. */
    const code = probe.pyodide
      ? `import piplite\nawait piplite.install([${list}], keep_going=True)\n`
      : `%pip install --quiet ${packages.map(name => `'${name}'`).join(' ')}\n`;

    const outcome = await kernel.execute(code, {
      onStream: (_name, text) => this._onStream(text)
    });
    if (outcome.status !== 'ok') {
      const why = outcome.error ? `${outcome.error.ename}: ${outcome.error.evalue}` : outcome.status;
      const message = `Installing ${packages.join(', ')} failed: ${why}`;
      this._report({ state: 'failed', message });
      throw new Error(message);
    }
  }

  private async _boot(kernel: KernelHandle): Promise<void> {
    /* learner.py and the bundled CSV, ~120 kB of base64, in the one message
       that has to carry them. See gen-assets.mjs for why they travel in the
       JavaScript bundle rather than being installed. */
    const { result } = await this._dispatch(kernel, {
      id: this._nextId++,
      kind: 'boot',
      learner: base64Utf8(LEARNER_SOURCE),
      airfoil: base64Utf8(AIRFOIL_CSV)
    });
    const booted = result as { ok?: boolean; error?: string; already?: boolean };
    if (!booted?.ok) {
      const message = booted?.error ?? 'learner.py did not load in the kernel.';
      this._report({ state: 'failed', message });
      throw new Error(message);
    }
    log.info(booted.already ? 'learner.py was already loaded' : 'learner.py loaded');
  }

  /* ---- the wire -------------------------------------------------------- */

  private async _dispatch(kernel: KernelHandle, request: unknown): Promise<CallResult> {
    const outcome = await kernel.execute(dispatchCode(request), {
      onStream: (_name, text) => this._onStream(text)
    });

    if (outcome.status === 'abort') {
      throw new UserError('Cancelled.');
    }

    const envelope = envelopeOf(outcome);
    if (!envelope) {
      /* No response at all. Either the kernel died mid-call, or the module is
         gone because something restarted it behind our back — in which case
         re-arming on the next attempt is the fix, so forget the injection. */
      forgetArmed(kernel.id);
      this._readying = null;
      const why =
        outcome.error?.evalue ??
        (outcome.stderr.trim().split('\n').pop() || 'the kernel returned nothing');
      throw new Error(`The kernel did not answer: ${why}`);
    }

    if (!envelope.ok) {
      const text = envelope.error ?? 'unknown Python error';
      throw envelope.user ? new UserError(text) : new Error(text);
    }
    return { result: envelope.result, bin: envelope.bin };
  }

  /** Split a stream chunk into lines and lift the runner's `::` progress out
   *  of it. Chunks are not line-delimited, hence the carry. */
  private _onStream(text: string): void {
    this._carry += text;
    const lines = this._carry.split('\n');
    this._carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith('::')) {
        const message = trimmed.slice(2).trim();
        log.info(message);
        this.progress.emit(message);
      } else {
        log.debug(`[kernel] ${trimmed}`);
      }
    }
  }

  private _report(status: RuntimeStatus): void {
    this._status = status;
    this.statusChanged.emit(status);
  }

  private _prompt: InstallPrompt | null = null;
  private _status: RuntimeStatus = { state: 'idle', message: 'Not started.' };
  private _probe: KernelProbe | null = null;
  private _readying: Promise<KernelHandle> | null = null;
  private _nextId = 1;
  private _carry = '';
}
