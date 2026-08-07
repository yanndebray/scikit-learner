import * as vscode from "vscode";
import { activeRuntime, registerSerializer, showPanel } from "./panel";
import { candidates, describe, probe } from "./python/discover";
import { provision, removeManaged } from "./python/provision";
import type { LearnerRuntime } from "./runner";
import { initLog, log } from "./util/log";

/** What `activate` hands back. Only the integration tests use it — driving
 *  the app is otherwise the webview's job. */
export interface LearnerApi {
  runtime(): LearnerRuntime | undefined;
}

export function activate(context: vscode.ExtensionContext): LearnerApi {
  initLog();
  log.info("Scikit-Learner activated");

  context.subscriptions.push(registerSerializer(context));

  const command = (id: string, run: (...args: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run));

  command("scikit-learner.open", () => showPanel(context));

  command("scikit-learner.setupEnvironment", async () => {
    try {
      const python = await provision(context, { reinstall: false });
      if (!python) return;
      vscode.window.showInformationMessage(
        "Scikit-Learner: the local Python environment is ready. " +
          "If a panel is open, run “Scikit-Learner: Restart Python runtime” to pick it up."
      );
    } catch (err) {
      if (err instanceof vscode.CancellationError) return;
      const LOG = "Show log";
      const answer = await vscode.window.showErrorMessage(
        `Scikit-Learner: ${(err as Error).message}`,
        LOG
      );
      if (answer === LOG) log.show();
    }
  });

  command("scikit-learner.removeEnvironment", () => removeManaged(context));

  command("scikit-learner.selectInterpreter", async () => {
    const found = await candidates(context);
    const items = await Promise.all(
      found.map(async (c) => {
        const info = await probe(c.path);
        return {
          label: c.path,
          description: info ? `Python ${info.version.join(".")}` : "not runnable",
          detail: info
            ? `${describe({ ...c, version: info.version })}${
                info.hasSklearn ? " · has scikit-learn" : " · scikit-learn not installed"
              }`
            : "This interpreter did not respond.",
          path: info ? c.path : undefined,
        };
      })
    );

    const BROWSE = "$(folder-opened) Browse…";
    const choice = await vscode.window.showQuickPick(
      [...items.filter((i) => i.path), { label: BROWSE, description: "", detail: "", path: "" }],
      { title: "Scikit-Learner — Python interpreter", placeHolder: "Interpreter" }
    );
    if (!choice) return false;

    let chosen = choice.path;
    if (choice.label === BROWSE) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Use this interpreter",
        title: "Select a Python interpreter",
      });
      if (!picked?.[0]) return false;
      chosen = picked[0].fsPath;
    }
    if (!chosen) return false;

    await vscode.workspace
      .getConfiguration("scikit-learner")
      .update("python.interpreterPath", chosen, vscode.ConfigurationTarget.Global);
    return true;
  });

  command("scikit-learner.restartPython", async () => {
    const runtime = activeRuntime();
    if (!runtime) {
      vscode.window.showInformationMessage(
        "Scikit-Learner: no panel is open — “Open Scikit-Learner” first."
      );
      return;
    }
    try {
      await runtime.restart();
      vscode.window.showInformationMessage(
        "Scikit-Learner: Python restarted. Loaded data and trained models were cleared."
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Scikit-Learner: ${(err as Error).message}`);
    }
  });

  command("scikit-learner.showLog", () => log.show());

  return { runtime: activeRuntime };
}

export function deactivate(): void {
  /* The panel's runtime is disposed with the panel via onDidDispose;
     everything else lives in context.subscriptions. */
}
