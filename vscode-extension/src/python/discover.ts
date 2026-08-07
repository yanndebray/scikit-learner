import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { run } from "./exec";
import { log } from "../util/log";

/* ------------------------------------------------------------------ */
/*  Which Python.                                                      */
/*                                                                     */
/*  Discovery is ordered so the most deliberate choice wins, and so    */
/*  that we never surprise someone who has already told VS Code which  */
/*  interpreter their project uses.                                    */
/*                                                                     */
/*    1. scikit-learner.python.interpreterPath — an explicit setting   */
/*    2. our own managed environment, if it exists                     */
/*    3. the Python extension's active environment, if installed       */
/*    4. a venv at the workspace root                                  */
/*    5. python3 / python on PATH                                      */
/*                                                                     */
/*  ms-python.python is soft-detected rather than declared as an       */
/*  extensionDependency: forcing a heavyweight install on someone who  */
/*  only wants to poke at a sample dataset is a worse default than     */
/*  missing their venv.                                                */
/* ------------------------------------------------------------------ */

export interface Interpreter {
  path: string;
  /** How we found it — shown in the picker and the log. */
  source: "setting" | "managed" | "python-extension" | "workspace" | "path";
  version?: [number, number, number];
  hasSklearn?: boolean;
}

export function managedEnvDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "env");
}

export function managedPython(context: vscode.ExtensionContext): string {
  const dir = managedEnvDir(context);
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");
}

export function managedEnvExists(context: vscode.ExtensionContext): boolean {
  return fs.existsSync(managedPython(context));
}

function venvPython(dir: string): string {
  return process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");
}

/** Version and whether sklearn + pandas are importable, without importing
 *  them — find_spec answers "is it there" for free. */
export async function probe(
  interpreterPath: string
): Promise<{ version: [number, number, number]; hasSklearn: boolean } | null> {
  const code =
    "import sys,json,importlib.util;" +
    "print(json.dumps({'v':list(sys.version_info[:3])," +
    "'s':all(importlib.util.find_spec(m) is not None " +
    "for m in ('sklearn','pandas','joblib'))}))";
  try {
    const r = await run(interpreterPath, ["-c", code]);
    if (r.code !== 0) {
      log.debug(`probe ${interpreterPath} exited ${r.code}: ${r.stderr.trim()}`);
      return null;
    }
    const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
      v: [number, number, number];
      s: boolean;
    };
    return { version: out.v, hasSklearn: out.s };
  } catch (err) {
    log.debug(`probe ${interpreterPath} failed: ${(err as Error).message}`);
    return null;
  }
}

/** The active environment reported by ms-python.python, if it is installed. */
async function fromPythonExtension(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension("ms-python.python");
  if (!ext) return undefined;
  try {
    if (!ext.isActive) await ext.activate();
    const api = ext.exports as {
      environments?: {
        getActiveEnvironmentPath(): { path: string };
        resolveEnvironment(p: unknown): Promise<{ executable?: { uri?: vscode.Uri } } | undefined>;
      };
    };
    const envPath = api.environments?.getActiveEnvironmentPath();
    if (!envPath) return undefined;
    const resolved = await api.environments?.resolveEnvironment(envPath);
    return resolved?.executable?.uri?.fsPath ?? envPath.path;
  } catch (err) {
    log.debug(`python extension API unavailable: ${(err as Error).message}`);
    return undefined;
  }
}

function workspaceVenv(): string | undefined {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const name of [".venv", "venv", "env", ".env"]) {
      const candidate = venvPython(path.join(folder.uri.fsPath, name));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Every interpreter we know about, in priority order, de-duplicated. */
export async function candidates(context: vscode.ExtensionContext): Promise<Interpreter[]> {
  const out: Interpreter[] = [];
  const push = (p: string | undefined, source: Interpreter["source"]) => {
    if (!p) return;
    if (out.some((c) => c.path === p)) return;
    out.push({ path: p, source });
  };

  const setting = vscode.workspace
    .getConfiguration("scikit-learner")
    .get<string>("python.interpreterPath", "")
    .trim();
  push(setting || undefined, "setting");
  if (managedEnvExists(context)) push(managedPython(context), "managed");
  push(await fromPythonExtension(), "python-extension");
  push(workspaceVenv(), "workspace");
  push(process.platform === "win32" ? "python" : "python3", "path");

  return out;
}

/**
 * The interpreter we would actually use, with its probe results filled in.
 *
 * Prefers a candidate that already has sklearn over an earlier one that
 * doesn't — the ordering above expresses "whose choice is this", but if the
 * user's project venv has sklearn and our managed env is stale, running in
 * theirs is what they meant.
 */
export async function resolve(context: vscode.ExtensionContext): Promise<Interpreter | null> {
  const list = await candidates(context);
  const probed: Interpreter[] = [];

  for (const c of list) {
    const info = await probe(c.path);
    if (!info) continue;
    const full: Interpreter = { ...c, version: info.version, hasSklearn: info.hasSklearn };
    if (info.version[0] < 3 || (info.version[0] === 3 && info.version[1] < 9)) {
      log.debug(`skipping ${c.path}: Python ${info.version.join(".")} < 3.9`);
      continue;
    }
    if (info.hasSklearn) return full;
    probed.push(full);
  }
  /* Nothing has sklearn. Return the highest-priority usable interpreter so
     the caller can offer to install into it. */
  return probed[0] ?? null;
}

export function describe(i: Interpreter): string {
  const where = {
    setting: "from scikit-learner.python.interpreterPath",
    managed: "Scikit-Learner's managed environment",
    "python-extension": "the Python extension's active environment",
    workspace: "a virtual environment in this workspace",
    path: "python on PATH",
  }[i.source];
  const v = i.version ? `Python ${i.version.join(".")}` : "Python";
  return `${v} — ${where}`;
}
