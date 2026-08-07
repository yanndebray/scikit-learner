import * as path from "node:path";
import * as vscode from "vscode";
import type { Run, Session } from "./session";

/* ------------------------------------------------------------------ */
/*  The sidebar: DATASET / MODELS / RUNS / ARTIFACTS.                  */
/*                                                                     */
/*  Four small tree views in one container (design 1a–1c). All of      */
/*  them render the Session and nothing else; interaction goes back    */
/*  through commands so the palette can drive everything the mouse     */
/*  can.                                                               */
/* ------------------------------------------------------------------ */

abstract class SessionTree<T> implements vscode.TreeDataProvider<T> {
  protected readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event as vscode.Event<T | undefined | null | void>;

  constructor(protected readonly session: Session) {
    session.onDidChange(() => this.emitter.fire());
  }

  abstract getTreeItem(element: T): vscode.TreeItem;
  abstract getChildren(element?: T): vscode.ProviderResult<T[]>;
}

/* ---- DATASET --------------------------------------------------------- */

export type DatasetNode =
  | { kind: "hint"; text: string }
  | { kind: "csv"; uri: vscode.Uri; label: string }
  | { kind: "file" }
  | { kind: "kv"; label: string; value: string; command?: string };

export class DatasetTree extends SessionTree<DatasetNode> {
  getTreeItem(node: DatasetNode): vscode.TreeItem {
    switch (node.kind) {
      case "hint": {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "csv": {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon("file");
        item.command = {
          command: "scikit-learner.loadCsv",
          title: "Load CSV",
          arguments: [node.uri],
        };
        return item;
      }
      case "file": {
        const ds = this.session.dataset!;
        const item = new vscode.TreeItem(ds.filename);
        item.description = `${ds.rows} × ${ds.columns.length}`;
        item.iconPath = new vscode.ThemeIcon("database", new vscode.ThemeColor("charts.blue"));
        item.tooltip = ds.fileUri?.fsPath ?? `sample: ${ds.sampleKey}`;
        return item;
      }
      case "kv": {
        const item = new vscode.TreeItem(node.label);
        item.description = node.value;
        if (node.command) {
          item.command = { command: node.command, title: node.label };
          item.tooltip = "Click to change";
        }
        return item;
      }
    }
  }

  async getChildren(node?: DatasetNode): Promise<DatasetNode[]> {
    if (node) return [];
    const ds = this.session.dataset;
    if (!ds) {
      const found = await vscode.workspace.findFiles("**/*.csv", "**/node_modules/**", 12);
      const csvs = found
        .map((uri) => ({
          kind: "csv" as const,
          uri,
          label: vscode.workspace.asRelativePath(uri),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
      const hint =
        csvs.length > 0
          ? { kind: "hint" as const, text: "No dataset selected. Found in this workspace:" }
          : { kind: "hint" as const, text: "No dataset selected — use + or load a sample." };
      return [hint, ...csvs];
    }
    return [
      { kind: "file" },
      { kind: "kv", label: "target", value: ds.target ?? "—", command: "scikit-learner.setTarget" },
      {
        kind: "kv",
        label: "features",
        value: `${ds.features.length} of ${ds.numericColumns.length}`,
        command: "scikit-learner.selectFeatures",
      },
      { kind: "kv", label: "task", value: ds.taskType, command: "scikit-learner.setTask" },
      {
        kind: "kv",
        label: "validation",
        value: `${ds.cvFolds}-fold CV`,
        command: "scikit-learner.setValidation",
      },
    ];
  }
}

/* ---- MODELS ---------------------------------------------------------- */

export type ModelNode = { kind: "category"; name: string } | { kind: "model"; key: string };

export class ModelsTree extends SessionTree<ModelNode> {
  getTreeItem(node: ModelNode): vscode.TreeItem {
    if (node.kind === "category") {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      return item;
    }
    const model = this.session.catalog.find((m) => m.key === node.key)!;
    const item = new vscode.TreeItem(model.name);
    item.checkboxState = this.session.selected.has(node.key)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = Object.entries(model.params)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join("\n");
    item.contextValue = "model";
    return item;
  }

  getChildren(node?: ModelNode): ModelNode[] {
    if (!node) {
      const categories = [...new Set(this.session.catalog.map((m) => m.category))];
      return categories.map((name) => ({ kind: "category", name }));
    }
    if (node.kind === "category") {
      return this.session.catalog
        .filter((m) => m.category === node.name)
        .map((m) => ({ kind: "model" as const, key: m.key }));
    }
    return [];
  }
}

/* ---- RUNS ------------------------------------------------------------ */

export class RunsTree extends SessionTree<Run> {
  getTreeItem(run: Run): vscode.TreeItem {
    const item = new vscode.TreeItem(run.name);
    const metric =
      this.session.dataset?.taskType === "classification" ? "cv_accuracy_mean" : "cv_r2_mean";
    switch (run.status) {
      case "running":
        item.iconPath = new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.orange"));
        item.description = "training…";
        break;
      case "queued":
        item.iconPath = new vscode.ThemeIcon("circle-outline");
        item.description = "queued";
        break;
      case "failed":
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
        item.description = "failed";
        item.tooltip = run.error;
        break;
      case "done": {
        const selected = run.key === this.session.selectedRunKey;
        item.iconPath = new vscode.ThemeIcon(
          selected ? "circle-large-filled" : "circle-filled",
          new vscode.ThemeColor(selected ? "charts.blue" : "charts.green")
        );
        item.description = (run.metrics?.[metric] ?? 0).toFixed(3);
        item.tooltip = Object.entries(run.metrics ?? {})
          .map(([k, v]) => `${k} = ${v}`)
          .join("\n");
        break;
      }
    }
    item.command = { command: "scikit-learner.selectRun", title: "Select run", arguments: [run.key] };
    item.contextValue = run.status === "done" ? "run-done" : "run";
    return item;
  }

  getChildren(node?: Run): Run[] {
    if (node) return [];
    const metric =
      this.session.dataset?.taskType === "classification" ? "cv_accuracy_mean" : "cv_r2_mean";
    const order: Record<string, number> = { running: 0, queued: 1, done: 2, failed: 3 };
    return [...this.session.runs].sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        (b.metrics?.[metric] ?? -1) - (a.metrics?.[metric] ?? -1)
    );
  }
}

/* ---- ARTIFACTS ------------------------------------------------------- */

export type ArtifactNode =
  | { kind: "pipeline" }
  | { kind: "metrics" }
  | { kind: "joblib"; key: string };

export class ArtifactsTree extends SessionTree<ArtifactNode> {
  getTreeItem(node: ArtifactNode): vscode.TreeItem {
    switch (node.kind) {
      case "pipeline": {
        const item = new vscode.TreeItem("pipeline.py");
        item.iconPath = new vscode.ThemeIcon("file-code");
        item.description = "generated";
        item.tooltip = "The sklearn code equivalent to the selected run";
        item.command = { command: "scikit-learner.openPipeline", title: "Open pipeline.py" };
        return item;
      }
      case "metrics": {
        const item = new vscode.TreeItem("metrics.json");
        item.iconPath = new vscode.ThemeIcon("json");
        item.description = "generated";
        item.command = { command: "scikit-learner.openMetrics", title: "Open metrics.json" };
        return item;
      }
      case "joblib": {
        const run = this.session.run(node.key)!;
        const item = new vscode.TreeItem(`${run.key}.joblib`);
        item.iconPath = new vscode.ThemeIcon("package");
        item.description = run.exportedBytes
          ? `${(run.exportedBytes / 1e6).toFixed(1)} MB`
          : "click to export";
        item.command = {
          command: "scikit-learner.exportRun",
          title: "Export model",
          arguments: [node.key],
        };
        return item;
      }
    }
  }

  getChildren(node?: ArtifactNode): ArtifactNode[] {
    if (node) return [];
    const done = this.session.runs.filter((r) => r.status === "done");
    if (done.length === 0) return [];
    return [
      { kind: "pipeline" },
      { kind: "metrics" },
      ...done.map((r) => ({ kind: "joblib" as const, key: r.key })),
    ];
  }
}

export function relativeLabel(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri) || path.basename(uri.fsPath);
}
