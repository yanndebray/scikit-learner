import * as vscode from "vscode";
import type { Session } from "./session";

/* ------------------------------------------------------------------ */
/*  Status bar: environment on the right, training progress while a     */
/*  queue is running, best run when idle.                              */
/* ------------------------------------------------------------------ */

export function registerStatusBar(session: Session): vscode.Disposable {
  const env = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  env.command = "scikit-learner.selectInterpreter";

  const runs = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  runs.command = "scikit-learner.open";

  const update = () => {
    /* env */
    const status = session.runtime.status();
    const v = session.runtime.versions;
    if (status.state === "ready") {
      env.text = `$(circle-filled) Python ${v.python ?? ""}`.trim();
      env.tooltip = `${status.detail}${v.sklearn ? `\nscikit-learn ${v.sklearn}` : ""}`;
      env.color = new vscode.ThemeColor("charts.green");
      env.show();
    } else if (status.state === "failed") {
      env.text = "$(circle-slash) Python";
      env.tooltip = status.message;
      env.color = new vscode.ThemeColor("charts.red");
      env.show();
    } else {
      env.hide();
    }

    /* training / best */
    if (session.training) {
      const queued = session.runs.filter((r) => session.queue.includes(r.key));
      const done = queued.filter((r) => r.status === "done" || r.status === "failed").length;
      const total = session.queue.length;
      const running = queued.find((r) => r.status === "running");
      runs.text = `$(loading~spin) Training ${Math.min(done + 1, total)} of ${total}${running ? ` · ${running.name}` : ""}`;
      runs.color = new vscode.ThemeColor("charts.orange");
      runs.show();
    } else {
      const doneRuns = session.runs.filter((r) => r.status === "done");
      const best = session.bestRun();
      if (doneRuns.length > 0 && best) {
        const metric =
          session.dataset?.taskType === "classification" ? "cv_accuracy_mean" : "cv_r2_mean";
        runs.text = `$(beaker) ${doneRuns.length} run${doneRuns.length === 1 ? "" : "s"} · best ${(best.metrics?.[metric] ?? 0).toFixed(3)}`;
        runs.color = new vscode.ThemeColor("charts.blue");
        runs.tooltip = `Best: ${best.name}`;
        runs.show();
      } else {
        runs.hide();
      }
    }
  };

  const subs = [session.onDidChange(update), session.runtime.onStatus(update)];
  update();

  return vscode.Disposable.from(env, runs, ...subs);
}
