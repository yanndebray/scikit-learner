import * as fs from "node:fs";
import * as vscode from "vscode";
import { LearnerRuntime, UserError, type RuntimeStatus } from "./runner";
import { log } from "./util/log";

/* ------------------------------------------------------------------ */
/*  The app panel.                                                     */
/*                                                                     */
/*  One webview hosting the unmodified frontend (app.js + styles.css   */
/*  synced from ../frontend), plus one LearnerRuntime — the pairing    */
/*  mirrors the web app's "one Pyodide instance per tab", because      */
/*  learner.py holds the session (dataframe, trained models) in module */
/*  state.                                                             */
/* ------------------------------------------------------------------ */

const VIEW_TYPE = "scikit-learner.app";

let open: { panel: vscode.WebviewPanel; runtime: LearnerRuntime } | undefined;

export function showPanel(context: vscode.ExtensionContext): void {
  if (open) {
    open.panel.reveal(open.panel.viewColumn ?? vscode.ViewColumn.Active);
    return;
  }
  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Scikit-Learner", vscode.ViewColumn.Active, {
    enableScripts: true,
    /* The whole session lives in the DOM and the Python process; a re-render
       on tab switch would wipe the UI half of it. */
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri],
  });
  adopt(context, panel);
}

/** The runtime of the currently open panel — for palette commands. */
export function activeRuntime(): LearnerRuntime | undefined {
  return open?.runtime;
}

function adopt(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  panel.webview.html = html(context, panel.webview);

  const runtime = new LearnerRuntime(context);
  open = { panel, runtime };

  const postStatus = (status: RuntimeStatus) => {
    void panel.webview.postMessage({ type: "status", ...statusMessage(status) });
  };
  const statusSub = runtime.onStatus(postStatus);

  const messageSub = panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "init": {
        postStatus(runtime.status());
        /* Kick the runtime; progress and failure both arrive as status
           events, so there is nothing to await here. */
        runtime.ensureStarted().catch((err) => log.error((err as Error).message));
        return;
      }
      case "py": {
        try {
          const r = await runtime.call(msg.fn as string, (msg.args as unknown[]) ?? [], msg.buf as string | undefined);
          void panel.webview.postMessage({
            type: "py-result",
            id: msg.id,
            ok: true,
            ...(r.bin !== undefined ? { bin: r.bin } : { result: r.result ?? null }),
          });
        } catch (err) {
          if (!(err instanceof UserError)) log.error(`${String(msg.fn)}: ${(err as Error).message}`);
          void panel.webview.postMessage({
            type: "py-result",
            id: msg.id,
            ok: false,
            error: (err as Error).message,
          });
        }
        return;
      }
      case "save": {
        await saveBytes(msg.filename as string, msg.b64 as string);
        return;
      }
      case "alert": {
        void vscode.window.showWarningMessage(`Scikit-Learner: ${String(msg.message)}`);
        return;
      }
    }
  });

  panel.onDidDispose(() => {
    statusSub.dispose();
    messageSub.dispose();
    runtime.dispose();
    if (open?.panel === panel) open = undefined;
  });
}

function statusMessage(status: RuntimeStatus): Record<string, unknown> {
  switch (status.state) {
    case "starting":
      return { state: "starting", message: status.message };
    case "ready":
      return { state: "ready", detail: status.detail };
    case "failed":
      return { state: "failed", message: status.message };
  }
}

async function saveBytes(filename: string, b64: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, filename) : vscode.Uri.file(filename),
    title: "Export from Scikit-Learner",
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(b64, "base64"));
  vscode.window.showInformationMessage(`Scikit-Learner: saved ${target.fsPath}`);
}

function html(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const uri = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, ...parts)).toString();

  const template = fs.readFileSync(
    vscode.Uri.joinPath(context.extensionUri, "webview", "index.html").fsPath,
    "utf8"
  );
  return template
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{styles}}", uri("media", "app", "styles.css"))
    .replaceAll("{{bridge}}", uri("webview", "vscode-bridge.js"))
    .replaceAll("{{app}}", uri("media", "app", "app.js"));
}

/** Brings the panel back after a window reload. */
export function registerSerializer(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
      adopt(context, panel);
    },
  });
}
