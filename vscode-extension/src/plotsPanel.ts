import * as fs from "node:fs";
import * as vscode from "vscode";
import type { Session } from "./session";
import { log } from "./util/log";

/* ------------------------------------------------------------------ */
/*  The plots editor.                                                  */
/*                                                                     */
/*  Design 1a: the editor tab is only plots (+ the run inspector       */
/*  column). Everything else — dataset, models, runs, artifacts —      */
/*  lives in the sidebar trees. The webview is a pure renderer: the    */
/*  host pushes the full session snapshot on every change, and the     */
/*  webview posts back user intents as commands.                       */
/*                                                                     */
/*  It is Probabl-branded (midnight canvas, sky/orange accents)        */
/*  inside native VS Code chrome — self-contained, no CDNs.            */
/* ------------------------------------------------------------------ */

const VIEW_TYPE = "scikit-learner.plots";

let open: vscode.WebviewPanel | undefined;

export function showPlots(context: vscode.ExtensionContext, session: Session): void {
  if (open) {
    open.reveal(open.viewColumn ?? vscode.ViewColumn.One);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    plotsTitle(session),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.extensionUri],
    }
  );
  adopt(context, session, panel);
}

function plotsTitle(session: Session): string {
  const name = session.dataset?.filename?.replace(/\.csv$/i, "").replace(/_dataset$/i, "");
  return name ? `${name} — plots` : "Scikit-Learner";
}

function adopt(
  context: vscode.ExtensionContext,
  session: Session,
  panel: vscode.WebviewPanel
): void {
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  panel.webview.html = html(context, panel.webview);
  open = panel;

  const push = () => {
    panel.title = plotsTitle(session);
    void panel.webview.postMessage({ type: "state", state: snapshot(session) });
  };

  const subs: vscode.Disposable[] = [
    session.onDidChange(push),
    session.runtime.onStatus(push),
    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      try {
        switch (msg.cmd) {
          case "ready":
            push();
            return;
          case "chooseDataset":
            await vscode.commands.executeCommand("scikit-learner.chooseDataset");
            return;
          case "loadSample":
            await vscode.commands.executeCommand("scikit-learner.loadSample");
            return;
          case "selectRun":
            session.selectRun(msg.key as string);
            return;
          case "exportRun":
            await vscode.commands.executeCommand("scikit-learner.exportRun", msg.key as string);
            return;
          case "openPipeline":
            await vscode.commands.executeCommand("scikit-learner.openPipeline");
            return;
          case "savePng": {
            const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
            const name = (msg.filename as string) || "plot.png";
            const target = await vscode.window.showSaveDialog({
              defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(name),
              title: "Save plot as PNG",
            });
            if (!target) return;
            await vscode.workspace.fs.writeFile(
              target,
              Buffer.from((msg.b64 as string).replace(/^data:image\/png;base64,/, ""), "base64")
            );
            vscode.window.showInformationMessage(`Scikit-Learner: saved ${target.fsPath}`);
            return;
          }
        }
      } catch (err) {
        log.error(`plots message ${String(msg.cmd)}: ${(err as Error).message}`);
        vscode.window.showErrorMessage(`Scikit-Learner: ${(err as Error).message}`);
      }
    }),
  ];

  panel.onDidDispose(() => {
    for (const s of subs) s.dispose();
    if (open === panel) open = undefined;
  });
}

/** Everything the webview renders, in one JSON-able object. */
function snapshot(session: Session): Record<string, unknown> {
  const ds = session.dataset;
  const selected = session.selectedRun();
  const model = selected && session.catalog.find((m) => m.key === selected.key);
  return {
    runtime: session.runtime.status(),
    training: session.training,
    dataset: ds && {
      filename: ds.filename,
      rows: ds.rows,
      taskType: ds.taskType,
      target: ds.target,
      features: ds.features,
      cvFolds: ds.cvFolds,
    },
    preview: session.preview,
    runs: session.runs.map((r) => ({
      key: r.key,
      name: r.name,
      category: r.category,
      status: r.status,
      metrics: r.metrics,
      fitSeconds: r.fitSeconds,
      error: r.error,
    })),
    selected: selected && {
      key: selected.key,
      name: selected.name,
      category: selected.category,
      metrics: selected.metrics,
      fitSeconds: selected.fitSeconds,
      trainedAt: selected.trainedAt,
      hyperparams: model?.params ?? {},
      details: selected.details ?? null,
    },
  };
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const uri = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...parts)).toString();
  const template = fs.readFileSync(
    vscode.Uri.joinPath(context.extensionUri, "webview", "plots.html").fsPath,
    "utf8"
  );
  return template
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{css}}", uri("webview", "plots.css"))
    .replaceAll("{{js}}", uri("webview", "plots.js"));
}

/** Brings the plots tab back after a window reload. */
export function registerPlotsSerializer(
  context: vscode.ExtensionContext,
  session: Session
): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      adopt(context, session, panel);
    },
  });
}
