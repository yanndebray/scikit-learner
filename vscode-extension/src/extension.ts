import * as vscode from "vscode";
import { ArtifactProvider, metricsUri, pipelineUri, SCHEME } from "./pipeline";
import { registerPlotsSerializer, showPlots } from "./plotsPanel";
import { candidates, describe, probe } from "./python/discover";
import { provision, removeManaged } from "./python/provision";
import { UserError } from "./runner";
import { SAMPLES, Session } from "./session";
import { registerStatusBar } from "./statusbar";
import { ArtifactsTree, DatasetTree, ModelsTree, RunsTree, type ModelNode } from "./trees";
import { initLog, log } from "./util/log";

/** What `activate` hands back. Only the integration tests use it. */
export interface LearnerApi {
  session: Session;
}

export function activate(context: vscode.ExtensionContext): LearnerApi {
  initLog();
  log.info("Scikit-Learner activated");

  const session = new Session(context);
  context.subscriptions.push(session);

  /* ---- sidebar: DATASET / MODELS / RUNS / ARTIFACTS ------------------- */

  const datasetTree = new DatasetTree(session);
  const modelsTree = new ModelsTree(session);
  const runsTree = new RunsTree(session);
  const artifactsTree = new ArtifactsTree(session);

  const modelsView = vscode.window.createTreeView("scikit-learner.models", {
    treeDataProvider: modelsTree,
    showCollapseAll: false,
    manageCheckboxStateManually: false,
  });
  const runsView = vscode.window.createTreeView("scikit-learner.runs", {
    treeDataProvider: runsTree,
  });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("scikit-learner.dataset", datasetTree),
    modelsView,
    runsView,
    vscode.window.registerTreeDataProvider("scikit-learner.artifacts", artifactsTree),
    modelsView.onDidChangeCheckboxState((e) => {
      for (const [node, checked] of e.items) {
        const n = node as ModelNode;
        if (n.kind === "model") {
          session.toggleModel(n.key, checked === vscode.TreeItemCheckboxState.Checked);
        }
      }
    }),
    session.onDidChange(() => {
      modelsView.description = session.catalog.length
        ? `${session.selected.size} / ${session.catalog.length}`
        : undefined;
      runsView.description = session.runs.length ? String(session.runs.length) : undefined;
    })
  );

  /* ---- generated artifacts -------------------------------------------- */

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ArtifactProvider(session)),
    registerPlotsSerializer(context, session),
    registerStatusBar(session)
  );

  /* ---- commands -------------------------------------------------------- */

  const command = (id: string, run: (...args: never[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await run(...args);
        } catch (err) {
          if (err instanceof vscode.CancellationError) return;
          const message = (err as Error).message;
          if (err instanceof UserError) {
            vscode.window.showWarningMessage(`Scikit-Learner: ${message}`);
          } else {
            log.error(message);
            vscode.window.showErrorMessage(`Scikit-Learner: ${message}`);
          }
        }
      })
    );

  command("scikit-learner.open", () => showPlots(context, session));

  command("scikit-learner.chooseDataset", async () => {
    const found = await vscode.workspace.findFiles("**/*.csv", "**/node_modules/**", 50);
    const BROWSE = "$(folder-opened) Browse…";
    const items = [
      ...found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
      { label: BROWSE, uri: undefined },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "Scikit-Learner — choose a dataset",
      placeHolder: "CSV files in this workspace",
    });
    if (!pick) return;
    let uri = pick.uri;
    if (!uri) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { CSV: ["csv"] },
        openLabel: "Load dataset",
      });
      uri = picked?.[0];
    }
    if (!uri) return;
    await withBusy(`Loading ${vscode.workspace.asRelativePath(uri)}…`, () => session.loadFile(uri!));
    showPlots(context, session);
  });

  command("scikit-learner.loadCsv", async (uri: vscode.Uri) => {
    await withBusy(`Loading ${vscode.workspace.asRelativePath(uri)}…`, () => session.loadFile(uri));
    showPlots(context, session);
  });

  command("scikit-learner.loadSample", async () => {
    const pick = await vscode.window.showQuickPick(
      SAMPLES.map((s) => ({ label: s.name, description: s.task, detail: s.detail, key: s.key })),
      { title: "Scikit-Learner — sample datasets", placeHolder: "Curated data to learn the workflow" }
    );
    if (!pick) return;
    await withBusy(`Loading ${pick.label}…`, () => session.loadSample(pick.key));
    showPlots(context, session);
  });

  command("scikit-learner.setTarget", async () => {
    const ds = session.dataset;
    if (!ds) throw new UserError("Load a dataset first.");
    const pick = await vscode.window.showQuickPick(
      ds.numericColumns.map((c) => ({ label: c, description: c === ds.target ? "current target" : "" })),
      { title: "Target column" }
    );
    if (pick) await session.setTarget(pick.label);
  });

  command("scikit-learner.selectFeatures", async () => {
    const ds = session.dataset;
    if (!ds) throw new UserError("Load a dataset first.");
    const picks = await vscode.window.showQuickPick(
      ds.numericColumns
        .filter((c) => c !== ds.target)
        .map((c) => ({ label: c, picked: ds.features.includes(c) })),
      { title: "Feature columns", canPickMany: true }
    );
    if (!picks) return;
    if (picks.length === 0) throw new UserError("Pick at least one feature.");
    session.setFeatures(picks.map((p) => p.label));
  });

  command("scikit-learner.setTask", async () => {
    if (!session.dataset) throw new UserError("Load a dataset first.");
    const pick = await vscode.window.showQuickPick(
      [
        { label: "regression", description: "predict a continuous value" },
        { label: "classification", description: "predict a class" },
      ],
      { title: "Task type" }
    );
    if (pick) await session.setTask(pick.label as "regression" | "classification");
  });

  command("scikit-learner.setValidation", async () => {
    if (!session.dataset) throw new UserError("Load a dataset first.");
    const pick = await vscode.window.showQuickPick(["3", "5", "10"], {
      title: "Cross-validation folds",
    });
    if (pick) session.setCvFolds(parseInt(pick, 10));
  });

  command("scikit-learner.trainSelected", async () => {
    showPlots(context, session);
    await session.train([...session.selected]);
  });

  command("scikit-learner.trainAll", async () => {
    showPlots(context, session);
    await session.train(session.catalog.map((m) => m.key));
  });

  command("scikit-learner.selectRun", (key: string) => {
    session.selectRun(key);
    showPlots(context, session);
  });

  command("scikit-learner.exportRun", async (arg?: string | { key?: string }) => {
    const key =
      typeof arg === "string" ? arg : arg?.key ?? session.selectedRunKey ?? session.bestRun()?.key;
    if (!key) throw new UserError("No trained model to export.");
    const target = await session.exportRun(key);
    if (target) {
      vscode.window.showInformationMessage(`Scikit-Learner: exported ${target.fsPath}`);
    }
  });

  command("scikit-learner.openPipeline", async () => {
    const doc = await vscode.workspace.openTextDocument(pipelineUri());
    await vscode.languages.setTextDocumentLanguage(doc, "python");
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });

  command("scikit-learner.openMetrics", async () => {
    const doc = await vscode.workspace.openTextDocument(metricsUri());
    await vscode.languages.setTextDocumentLanguage(doc, "json");
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  });

  command("scikit-learner.restartPython", async () => {
    await session.reset();
    vscode.window.showInformationMessage(
      "Scikit-Learner: Python restarted. Loaded data and trained models were cleared."
    );
  });

  /* ---- environment plumbing (unchanged from 0.1.x) --------------------- */

  command("scikit-learner.setupEnvironment", async () => {
    const python = await provision(context, { reinstall: false });
    if (!python) return;
    vscode.window.showInformationMessage(
      "Scikit-Learner: the local Python environment is ready. " +
        "Run “Scikit-Learner: Restart Python runtime” if a session is open."
    );
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

  command("scikit-learner.showLog", () => log.show());

  return { session };
}

/** Progress toast around a session mutation; errors bubble to `command`. */
function withBusy<T>(title: string, work: () => Promise<T>): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Scikit-Learner: ${title}` },
      work
    )
  );
}

export function deactivate(): void {
  /* Session (and its Python process) is in context.subscriptions. */
}
