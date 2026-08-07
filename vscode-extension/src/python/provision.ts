import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { available, run } from "./exec";
import { candidates, managedEnvDir, managedPython, probe } from "./discover";
import { log } from "../util/log";

/* ------------------------------------------------------------------ */
/*  Making a Python environment that has scikit-learn in it.           */
/*                                                                     */
/*  uv first — seconds instead of tens of seconds is the difference    */
/*  between "it set itself up" and "it hung". venv + pip is the        */
/*  fallback, not the plan.                                            */
/*                                                                     */
/*  The environment lives in globalStorage, so it is provisioned once  */
/*  per install rather than once per project.                          */
/* ------------------------------------------------------------------ */

const PACKAGES = ["scikit-learn", "pandas", "joblib"];

async function useUv(): Promise<boolean> {
  if (!vscode.workspace.getConfiguration("scikit-learner").get<boolean>("python.useUv", true))
    return false;
  return available("uv");
}

/** A base interpreter to build the venv from — the newest usable one we can see. */
async function basePython(context: vscode.ExtensionContext): Promise<string | null> {
  for (const c of await candidates(context)) {
    if (c.source === "managed") continue; // don't seed from ourselves
    const info = await probe(c.path);
    if (info && (info.version[0] > 3 || (info.version[0] === 3 && info.version[1] >= 9))) {
      return c.path;
    }
  }
  return null;
}

/**
 * Create (or repair) the managed environment and install the scientific
 * stack into it. Returns the interpreter path, or null if the user cancelled.
 */
export async function provision(
  context: vscode.ExtensionContext,
  { reinstall = false } = {}
): Promise<string | null> {
  const dir = managedEnvDir(context);
  const python = managedPython(context);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Scikit-Learner: setting up Python",
      cancellable: true,
    },
    async (progress, token) => {
      const step = (message: string) => {
        log.info(message);
        progress.report({ message });
      };

      await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
      const uv = await useUv();
      log.info(`provisioning with ${uv ? "uv" : "venv + pip"} into ${dir}`);

      if (reinstall && fs.existsSync(dir)) {
        step("removing the old environment…");
        await fs.promises.rm(dir, { recursive: true, force: true });
      }

      /* --- the environment ------------------------------------------- */
      if (!fs.existsSync(python)) {
        step(uv ? "creating the environment with uv…" : "creating the environment…");
        if (uv) {
          const r = await run("uv", ["venv", dir], { token });
          if (r.code !== 0) throw new Error(`uv venv failed: ${tail(r.stderr)}`);
        } else {
          const base = await basePython(context);
          if (!base) {
            throw new Error(
              "No Python 3.9+ found. Install Python, or point " +
                "scikit-learner.python.interpreterPath at one."
            );
          }
          const r = await run(base, ["-m", "venv", dir], { token });
          if (r.code !== 0) throw new Error(`venv creation failed: ${tail(r.stderr)}`);
        }
      }

      /* --- the packages ----------------------------------------------- */
      step(`installing ${PACKAGES.join(", ")}…`);
      const onLine = (line: string) => {
        const t = line.trim();
        if (!t) return;
        log.debug(t);
        if (/^(Resolved|Prepared|Installed|Downloading|Collecting|Building)/i.test(t)) {
          progress.report({ message: t.slice(0, 120) });
        }
      };

      const install = uv
        ? await run("uv", ["pip", "install", "--python", python, "--upgrade", ...PACKAGES], {
            token,
            onLine,
          })
        : await run(python, ["-m", "pip", "install", "--upgrade", ...PACKAGES], { token, onLine });

      if (install.code !== 0) {
        throw new Error(`Installing packages failed: ${tail(install.stderr || install.stdout)}`);
      }

      step("verifying…");
      const info = await probe(python);
      if (!info?.hasSklearn) {
        throw new Error(
          `scikit-learn installed but is not importable from ${python}. See the Scikit-Learner log.`
        );
      }

      log.info(`managed environment ready: ${python} (Python ${info.version.join(".")})`);
      return python;
    }
  );
}

/** Install the scientific stack into an interpreter the user already has. */
export async function installInto(
  interpreterPath: string,
  token?: vscode.CancellationToken
): Promise<void> {
  const uv = await useUv();
  const r = uv
    ? await run(
        "uv",
        ["pip", "install", "--python", interpreterPath, "--upgrade", ...PACKAGES],
        { token }
      )
    : await run(interpreterPath, ["-m", "pip", "install", "--upgrade", ...PACKAGES], { token });
  if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout));
}

export async function removeManaged(context: vscode.ExtensionContext): Promise<void> {
  const dir = managedEnvDir(context);
  if (!fs.existsSync(dir)) {
    vscode.window.showInformationMessage(
      "Scikit-Learner: there is no managed environment to remove."
    );
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    "Delete Scikit-Learner's managed Python environment?",
    { modal: true, detail: dir },
    "Delete"
  );
  if (answer !== "Delete") return;
  await fs.promises.rm(dir, { recursive: true, force: true });
  vscode.window.showInformationMessage("Scikit-Learner: managed environment removed.");
}

/* pip and uv failures are long. The last few lines carry the reason. */
function tail(text: string, lines = 6): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
