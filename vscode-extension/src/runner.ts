import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { describe, resolve, type Interpreter } from "./python/discover";
import { installInto, provision } from "./python/provision";
import { log } from "./util/log";

/* ------------------------------------------------------------------ */
/*  The local Python runtime.                                          */
/*                                                                     */
/*  One long-lived process per panel, mirroring the web app's "one     */
/*  Pyodide instance per tab": learner.py keeps its dataframe and      */
/*  trained models in module state, so the process IS the session.     */
/*                                                                     */
/*  Protocol: line-delimited JSON on stdin/stdout (see                 */
/*  python/learner_server.py). stdout is the protocol, stderr is a     */
/*  log — sklearn's convergence warnings land there, not in responses. */
/* ------------------------------------------------------------------ */

export interface CallResult {
  result?: unknown;
  /** base64 payload for bytes-returning functions (export_model, bulk_zip). */
  bin?: string;
}

/** A user-facing error — learner.py raised ValueError, meant for the UI. */
export class UserError extends Error {}

interface Pending {
  resolve: (r: CallResult) => void;
  reject: (e: Error) => void;
}

export type RuntimeStatus =
  | { state: "starting"; message: string }
  | { state: "ready"; detail: string }
  | { state: "failed"; message: string };

export class LearnerRuntime implements vscode.Disposable {
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private disposed = false;

  private readonly statusEmitter = new vscode.EventEmitter<RuntimeStatus>();
  readonly onStatus = this.statusEmitter.event;
  private lastStatus: RuntimeStatus = { state: "starting", message: "Starting local Python…" };

  /** Versions reported by the server's ready handshake — for the status bar. */
  versions: { python?: string; sklearn?: string } = {};

  constructor(private readonly context: vscode.ExtensionContext) {}

  status(): RuntimeStatus {
    return this.lastStatus;
  }

  private report(status: RuntimeStatus): void {
    this.lastStatus = status;
    this.statusEmitter.fire(status);
  }

  /** Start (or join the in-flight start of) the Python process. */
  ensureStarted(): Promise<void> {
    this.startPromise ??= this.start().catch((err) => {
      this.startPromise = null; // a failed start can be retried
      throw err;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.report({ state: "starting", message: "Finding a Python with scikit-learn…" });

    const interpreter = await this.readyInterpreter();
    if (!interpreter) {
      const message =
        "No Python environment with scikit-learn. Run “Scikit-Learner: Set up local Python environment”.";
      this.report({ state: "failed", message });
      throw new Error(message);
    }

    this.report({ state: "starting", message: "Starting the Python runtime…" });
    const server = path.join(this.context.extensionUri.fsPath, "python", "learner_server.py");
    log.info(`starting runtime: ${interpreter.path} -u ${server}`);

    const child = spawn(interpreter.path, ["-u", server], { stdio: "pipe" });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) log.debug(`[python] ${line}`);
    });
    child.on("close", (code) => this.onExit(code));
    child.on("error", (err) => {
      log.error(`runtime spawn failed: ${err.message}`);
      this.failAll(new Error(`Python failed to start: ${err.message}`));
    });

    /* The server prints {"event":"ready"} once learner.py (and with it
       sklearn/pandas — a few seconds cold) has been imported. */
    await new Promise<void>((resolveReady, rejectReady) => {
      this.readyWaiter = { resolve: resolveReady, reject: rejectReady };
    });

    this.report({ state: "ready", detail: describe(interpreter) });
    log.info(`runtime ready: ${describe(interpreter)}`);
  }

  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  /** Interpreter discovery plus the first-run flow: the environment question
   *  arrives when the panel needs Python, with a one-click fix. */
  private async readyInterpreter(): Promise<Interpreter | null> {
    let found = await resolve(this.context);
    if (found?.hasSklearn) return found;

    if (found && !found.hasSklearn && found.source !== "path") {
      /* We have an interpreter, it just doesn't have sklearn. Offer the
         smallest possible action first: install into the environment they
         already chose. */
      const INSTALL = "Install scikit-learn";
      const OWN = "Create a separate environment";
      const answer = await vscode.window.showInformationMessage(
        `Scikit-Learner runs models locally, and ${describe(found)} doesn't have scikit-learn yet.`,
        { modal: true, detail: found.path },
        INSTALL,
        OWN
      );
      if (answer === OWN) return this.provisioned();
      if (answer !== INSTALL) return null;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Scikit-Learner: installing scikit-learn + pandas",
            cancellable: true,
          },
          (_p, token) => installInto(found!.path, token)
        );
      } catch (err) {
        if (err instanceof vscode.CancellationError) return null;
        log.error(`install into ${found.path} failed: ${(err as Error).message}`);
        vscode.window.showErrorMessage(
          `Scikit-Learner: installing into ${found.path} failed — ${(err as Error).message}`
        );
        return null;
      }
      found = await resolve(this.context);
      return found?.hasSklearn ? found : null;
    }

    /* Nothing usable, or only a bare python3 on PATH we shouldn't install
       into. Offer to build our own. */
    const CREATE = "Set up for me";
    const PICK = "Pick an interpreter…";
    const answer = await vscode.window.showInformationMessage(
      "Scikit-Learner trains models with scikit-learn running on this machine. It needs a " +
        "Python environment with scikit-learn and pandas — about a minute, once.",
      { modal: true, detail: "Everything stays local; nothing is sent anywhere." },
      CREATE,
      PICK
    );
    if (answer === PICK) {
      const picked = await vscode.commands.executeCommand<boolean>(
        "scikit-learner.selectInterpreter"
      );
      if (!picked) return null;
      return this.readyInterpreter();
    }
    if (answer !== CREATE) return null;
    return this.provisioned();
  }

  private async provisioned(): Promise<Interpreter | null> {
    try {
      const python = await provision(this.context, { reinstall: false });
      if (!python) return null;
      const found = await resolve(this.context);
      return found?.hasSklearn ? found : null;
    } catch (err) {
      if (err instanceof vscode.CancellationError) return null;
      log.error(`provisioning failed: ${(err as Error).message}`);
      vscode.window.showErrorMessage(`Scikit-Learner: ${(err as Error).message}`);
      return null;
    }
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.warn(`unparsed runtime stdout: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.event === "ready") {
        this.versions = {
          python: msg.python as string | undefined,
          sklearn: msg.sklearn as string | undefined,
        };
        this.readyWaiter?.resolve();
        this.readyWaiter = null;
        continue;
      }
      if (msg.event === "fatal") {
        const err = new Error(String(msg.error ?? "the Python runtime failed to initialize"));
        this.readyWaiter?.reject(err);
        this.readyWaiter = null;
        continue;
      }
      const pending = this.pending.get(msg.id as number);
      if (!pending) {
        log.warn(`response for unknown request id ${String(msg.id)}`);
        continue;
      }
      this.pending.delete(msg.id as number);
      if (msg.ok) {
        pending.resolve({ result: msg.result, bin: msg.bin as string | undefined });
      } else {
        const text = String(msg.error ?? "unknown Python error");
        pending.reject(msg.user ? new UserError(text) : new Error(text));
      }
    }
  }

  private onExit(code: number | null): void {
    log.info(`runtime exited with code ${code}`);
    this.child = null;
    this.startPromise = null;
    const err = new Error(
      `The Python runtime exited unexpectedly (code ${code}). See the Scikit-Learner log.`
    );
    this.readyWaiter?.reject(err);
    this.readyWaiter = null;
    this.failAll(err);
    if (!this.disposed) {
      this.report({ state: "failed", message: err.message });
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /**
   * Call a top-level learner.py function. `bufB64` is prepended by the
   * server as bytes — the upload_csv path.
   */
  async call(fn: string, args: unknown[], bufB64?: string): Promise<CallResult> {
    await this.ensureStarted();
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error("The Python runtime is not running.");

    const id = this.nextId++;
    const request: Record<string, unknown> = { id, fn, args };
    if (bufB64 !== undefined) request.buf = bufB64;

    return new Promise<CallResult>((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      child.stdin!.write(JSON.stringify(request) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          rejectCall(err);
        }
      });
    });
  }

  async restart(): Promise<void> {
    this.stop();
    await this.ensureStarted();
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.failAll(new Error("The Python runtime was restarted."));
    if (child) {
      child.removeAllListeners("close");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.statusEmitter.dispose();
  }
}
