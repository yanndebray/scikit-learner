import * as vscode from "vscode";

/* One output channel for the whole extension. Everything that can fail
   silently — interpreter discovery, subprocess stderr, sklearn warnings —
   writes here, because "training didn't work and I don't know why" is the
   failure mode that costs the most support. */

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("Scikit-Learner", { log: true });
  return channel;
}

export const log = {
  info: (m: string, ...a: unknown[]) => channel?.info(m, ...a),
  warn: (m: string, ...a: unknown[]) => channel?.warn(m, ...a),
  error: (m: string | Error, ...a: unknown[]) => channel?.error(m as string, ...a),
  debug: (m: string, ...a: unknown[]) => channel?.debug(m, ...a),
  show: () => channel?.show(true),
};
