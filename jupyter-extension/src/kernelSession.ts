import type { JupyterFrontEnd } from '@jupyterlab/application';
import { SessionContext } from '@jupyterlab/apputils';
import type { ISessionContext } from '@jupyterlab/apputils';
import type { Kernel } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';

import { wrapKernel } from './kernel.js';
import { UserError } from './types.js';
import type { KernelHandle, KernelSupplier, LearnerSettingsSource } from './types.js';

/* ------------------------------------------------------------------ *
 *  One kernel, started on the first thing that needs Python and not   *
 *  before.                                                            *
 *                                                                     *
 *  The VS Code extension spawns a Python subprocess and keeps it for  *
 *  the window, because learner.py holds the dataframe and the fitted  *
 *  models in module state: the process IS the session. A front-end    *
 *  extension has no subprocess, so the kernel plays that part, and    *
 *  the correspondence is exact — one kernel, module state inside it,  *
 *  restart throws the session away.                                   *
 *                                                                     *
 *  It is Scikit-Learner's own kernel rather than the active           *
 *  notebook's. Adopting whatever notebook happens to be focused would *
 *  mean the panel's contents changed when you switched tabs, and      *
 *  would put a multi-megabyte dataframe in a namespace the user       *
 *  believes is theirs.                                                *
 *                                                                     *
 *  The laziness matters most in JupyterLite: booting Pyodide and      *
 *  fetching scikit-learn is a real download, and a user who opens the *
 *  panel to look at it must not pay for one.                          *
 * ------------------------------------------------------------------ */

const SESSION_PATH = 'scikit-learner-session';

export interface LearnerKernelOptions {
  app: JupyterFrontEnd;
  settings: LearnerSettingsSource;
  /** Absent in Notebook 7 and in a bare JupyterLite page. Without it we
   *  cannot prompt, so an ambiguous kernel choice becomes an error the panel
   *  can explain rather than a dialog that never appears. */
  dialogs: ISessionContext.IDialogs | null;
}

export class LearnerKernel implements IDisposable {
  /** Fires on every kernel status change, so the status bar can show a busy
   *  kernel without polling. */
  readonly statusChanged = new Signal<LearnerKernel, Kernel.Status>(this);

  constructor(options: LearnerKernelOptions) {
    this._options = options;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  /** True once a kernel exists — the panel uses it to say "not started yet"
   *  rather than "failed", and to avoid probing something that isn't there. */
  get started(): boolean {
    return this._handle != null && !this._handle.isDisposed;
  }

  get displayName(): string | null {
    return this._handle?.displayName ?? null;
  }

  /** What the runtime is handed. Bound, so it travels as a plain function. */
  readonly supply: KernelSupplier = () => this.kernel();

  async kernel(): Promise<KernelHandle> {
    if (this._disposed) {
      throw new UserError('Scikit-Learner is shutting down.');
    }
    const handle = this._handle;
    if (handle && !handle.isDisposed) {
      return handle;
    }
    if (!this._starting) {
      this._starting = this._start();
      /* Clear the in-flight promise either way, so a failed start — no Python
         kernel installed, the picker cancelled — can be retried by pressing
         the button again rather than failing for the rest of the session. */
      void this._starting
        .catch(() => undefined)
        .then(() => {
          this._starting = null;
        });
    }
    return this._starting;
  }

  /** Restart the kernel, which is what throws away learner.py's module state.
   *  The VS Code extension answers the same command by killing its
   *  subprocess. */
  async restart(): Promise<void> {
    const context = this._context;
    this._handle = null;
    if (!context?.session?.kernel) {
      return;
    }
    await context.restartKernel();
  }

  async interrupt(): Promise<void> {
    await this._handle?.interrupt();
  }

  /** Change which Python the models are fitted in — the counterpart of the VS
   *  Code extension's interpreter picker. Starting the session first is what
   *  makes this work before the first fit: `selectKernel` needs a
   *  SessionContext to change, and there is none until something asks. */
  async select(): Promise<void> {
    const dialogs = this._options.dialogs;
    if (!dialogs) {
      throw new UserError(
        'This front end has no kernel picker. Set `kernelName` in ' +
          'Settings ▸ Scikit-Learner instead.'
      );
    }
    await this.kernel();
    const context = this._context;
    if (context) {
      await dialogs.selectKernel(context);
    }
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._handle = null;
    const context = this._context;
    this._context = null;
    if (context) {
      context.kernelChanged.disconnect(this._onKernelChanged, this);
      context.statusChanged.disconnect(this._onStatusChanged, this);
      /* shutdownOnDispose means disposing takes the kernel with it — this one
         has no reason to outlive the extension. */
      context.dispose();
    }
    Signal.clearData(this);
  }

  private async _start(): Promise<KernelHandle> {
    const { app, settings, dialogs } = this._options;

    let context = this._context;
    if (!context) {
      context = new SessionContext({
        sessionManager: app.serviceManager.sessions,
        specsManager: app.serviceManager.kernelspecs,
        kernelManager: app.serviceManager.kernels,
        path: SESSION_PATH,
        name: 'Scikit-Learner',
        type: 'scikit-learner',
        kernelPreference: {
          name: settings.current.kernelName || undefined,
          language: 'python',
          autoStartDefault: true,
          shutdownOnDispose: true
        }
      });
      context.kernelChanged.connect(this._onKernelChanged, this);
      context.statusChanged.connect(this._onStatusChanged, this);
      this._context = context;
    }

    const shouldPrompt = await context.initialize();
    if (shouldPrompt) {
      if (!dialogs) {
        throw new UserError(
          'Scikit-Learner could not decide which kernel to run in, and this ' +
            'front end offers no kernel picker. Set the `kernelName` setting.'
        );
      }
      await dialogs.selectKernel(context);
    }
    await context.ready;

    const connection = context.session?.kernel ?? null;
    if (!connection) {
      throw new UserError(
        'No Python kernel started, so there is nothing to fit models in. ' +
          'Install a Python kernel, or pick one in Settings ▸ Scikit-Learner.'
      );
    }

    const handle = wrapKernel(connection);
    this._handle = handle;
    return handle;
  }

  private _onKernelChanged(): void {
    /* A different kernel is a different Python: drop the handle so the next
       call re-wraps it and the runtime re-injects and re-boots. */
    this._handle = null;
  }

  private _onStatusChanged(_: unknown, status: Kernel.Status): void {
    /* A restart empties sys.modules, so `_sklearner_runner` is gone even
       though the kernel id has not changed. src/kernel.ts disarms the
       injection off the same signal; dropping the handle here is what makes
       the next call notice. */
    if (status === 'restarting' || status === 'autorestarting' || status === 'dead') {
      this._handle = null;
    }
    this.statusChanged.emit(status);
  }

  private readonly _options: LearnerKernelOptions;
  private _context: SessionContext | null = null;
  private _handle: KernelHandle | null = null;
  private _starting: Promise<KernelHandle> | null = null;
  private _disposed = false;
}
