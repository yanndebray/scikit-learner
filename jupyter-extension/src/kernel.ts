import { KernelMessage } from '@jupyterlab/services';

import type { Kernel } from '@jupyterlab/services';

import type { KernelExecOptions, KernelExecOutcome, KernelHandle } from './types.js';

/* ------------------------------------------------------------------ *
 *  A kernel, reduced to what the runtime needs.                       *
 *                                                                     *
 *  Nothing here knows about widgets, sessions or the session model:   *
 *  it takes a Kernel.IKernelConnection and hands back the structural  *
 *  KernelHandle from types.ts. That seam is what lets                 *
 *  kernelSession.ts own the SessionContext lifecycle without          *
 *  importing the runtime, and runtime.ts run Python without importing *
 *  a SessionContext.                                                  *
 *                                                                     *
 *  It is the JupyterLab counterpart of the VS Code extension's        *
 *  child-process plumbing in src/runner.ts: same job, one long-lived  *
 *  Python that IS the session, different transport.                   *
 * ------------------------------------------------------------------ */

/** btoa() only speaks latin-1, and a CSV is full of names that aren't. */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  /* Chunked: String.fromCharCode(...bytes) blows the argument limit on
     anything above a few hundred kB, which is exactly the size of upload
     this path exists for. */
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The inverse, for a joblib coming back out of the kernel. */
export function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

type ExecFuture = Kernel.IShellFuture<
  KernelMessage.IExecuteRequestMsg,
  KernelMessage.IExecuteReplyMsg
>;

class ConnectionHandle implements KernelHandle {
  constructor(private readonly _conn: Kernel.IKernelConnection) {
    /* The kernelspec name is what we have synchronously; the spec request
       refines it to the display name a user would recognise. Every caller
       runs long after this, and all of them degrade gracefully if it somehow
       has not landed. */
    this._displayName = _conn.name;
    void _conn.spec
      .then(spec => {
        if (spec) {
          this._displayName = spec.display_name || spec.name;
          this._language = spec.language;
        }
      })
      .catch(() => undefined);
  }

  get id(): string {
    return this._conn.id;
  }

  get displayName(): string {
    return this._displayName;
  }

  get language(): string {
    return this._language;
  }

  get isDisposed(): boolean {
    return this._conn.isDisposed;
  }

  async execute(code: string, options: KernelExecOptions = {}): Promise<KernelExecOutcome> {
    const outcome: KernelExecOutcome = {
      status: 'ok',
      json: null,
      stdout: '',
      stderr: '',
      error: null
    };

    if (options.signal?.aborted) {
      return { ...outcome, status: 'abort' };
    }

    const future = this._conn.requestExecute({
      code,
      silent: false,
      /* Out of the user's In[]/Out[] history: this is the extension talking
         to the kernel, not something they typed. */
      store_history: false,
      allow_stdin: false,
      stop_on_error: true
    });
    this._inFlight.add(future);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.interrupt();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
      if (KernelMessage.isStreamMsg(msg)) {
        const { name, text } = msg.content;
        if (name === 'stdout') {
          outcome.stdout += text;
        } else {
          outcome.stderr += text;
        }
        options.onStream?.(name as 'stdout' | 'stderr', text);
        return;
      }
      if (KernelMessage.isExecuteResultMsg(msg) || KernelMessage.isDisplayDataMsg(msg)) {
        const data = msg.content.data as Record<string, unknown>;
        /* A real object off the wire, not a parsed repr — which is why the
           runner displays an application/json bundle rather than printing.
           A repr can be truncated and its quoting is a minefield. */
        if (data['application/json'] !== undefined) {
          outcome.json = data['application/json'];
        }
        return;
      }
      if (KernelMessage.isErrorMsg(msg)) {
        const { ename, evalue, traceback } = msg.content;
        outcome.error = { ename, evalue, traceback };
      }
    };

    try {
      const reply = await future.done;
      /* The reply's status is 'ok' | 'error' | 'abort' | 'aborted' — the
         second spelling is the pre-5.1 protocol's, which kernels still in the
         wild send. Both mean the same thing here. */
      const status = reply.content.status as string;
      outcome.status = status === 'ok' ? 'ok' : status === 'abort' || status === 'aborted' ? 'abort' : 'error';
    } catch {
      /* Disposing a future before its replies are done rejects `done`. That
         is how cancellation arrives here, and it is not an error. */
      outcome.status = aborted ? 'abort' : 'error';
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this._inFlight.delete(future);
      future.dispose();
    }

    if (aborted) {
      outcome.status = 'abort';
    }
    return outcome;
  }

  async interrupt(): Promise<void> {
    try {
      await this._conn.interrupt();
    } finally {
      /* The interrupt lands as a KeyboardInterrupt inside the fit, but the
         future would keep waiting for an idle status a wedged kernel may
         never send. Dropping it is what makes Cancel immediate. */
      for (const future of [...this._inFlight]) {
        this._inFlight.delete(future);
        future.dispose();
      }
    }
  }

  private _displayName: string;
  private _language = '';
  private readonly _inFlight = new Set<ExecFuture>();
}

/* Which kernels already have `_sklearner_runner` in sys.modules. A restart
   wipes sys.modules on the Python side without changing the kernel id, so the
   entry is dropped when the kernel says it is restarting — otherwise the next
   call reaches for a module that is no longer there and fails with a NameError
   nobody can act on. */
const armed = new Set<string>();
const watched = new WeakSet<Kernel.IKernelConnection>();

export function wrapKernel(conn: Kernel.IKernelConnection): KernelHandle {
  if (!watched.has(conn)) {
    watched.add(conn);
    conn.statusChanged.connect((_sender, status) => {
      if (status === 'restarting' || status === 'autorestarting' || status === 'dead') {
        armed.delete(conn.id);
      }
    });
    conn.disposed.connect(() => armed.delete(conn.id));
  }
  return new ConnectionHandle(conn);
}

/** Has the runner module been exec'd into this kernel since it last (re)started? */
export function isArmed(kernelId: string): boolean {
  return armed.has(kernelId);
}

export function markArmed(kernelId: string): void {
  armed.add(kernelId);
}

/** Forget the injection — after a failed inject, or for a caller that knows
 *  the kernel restarted before its statusChanged signal arrived. */
export function forgetArmed(kernelId: string): void {
  armed.delete(kernelId);
}
