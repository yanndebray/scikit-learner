import { spawn, type SpawnOptions } from "node:child_process";
import * as vscode from "vscode";
import { log } from "../util/log";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command to completion, collecting both streams.
 *
 * Cancellation kills the process rather than just detaching from it: a pip
 * resolve does not check for interrupts often, and an orphaned child is a
 * very visible bug. SIGTERM first, SIGKILL after a grace period.
 */
export function run(
  command: string,
  args: string[],
  opts: SpawnOptions & {
    token?: vscode.CancellationToken;
    onLine?: (line: string, stream: "out" | "err") => void;
    stdin?: string;
  } = {}
): Promise<RunResult> {
  const { token, onLine, stdin, ...spawnOpts } = opts;
  log.debug(`run: ${command} ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOpts, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let killTimer: NodeJS.Timeout | undefined;

    const sub = token?.onCancellationRequested(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    });

    const pump = (chunk: string, which: "out" | "err") => {
      if (which === "out") {
        stdout += chunk;
        outBuf += chunk;
      } else {
        stderr += chunk;
        errBuf += chunk;
      }
      if (!onLine) return;
      let buf = which === "out" ? outBuf : errBuf;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) onLine(line, which);
      }
      if (which === "out") outBuf = buf;
      else errBuf = buf;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => pump(c, "out"));
    child.stderr?.on("data", (c: string) => pump(c, "err"));

    child.on("error", (err) => {
      clearTimeout(killTimer);
      sub?.dispose();
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      sub?.dispose();
      /* Flush whatever is left in the buffers — a child that writes its last
         line without a trailing newline would otherwise have that line
         silently swallowed by the splitter above. */
      if (onLine) {
        if (outBuf.trim()) onLine(outBuf.trim(), "out");
        if (errBuf.trim()) onLine(errBuf.trim(), "err");
        outBuf = "";
        errBuf = "";
      }
      if (token?.isCancellationRequested) reject(new vscode.CancellationError());
      else resolve({ code, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/** Is this executable on PATH and runnable? */
export async function available(command: string, versionArg = "--version"): Promise<boolean> {
  try {
    const r = await run(command, [versionArg]);
    return r.code === 0;
  } catch {
    return false;
  }
}
