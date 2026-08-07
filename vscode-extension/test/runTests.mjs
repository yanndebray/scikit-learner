import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/* Boots a real VS Code, loads the extension into it and runs the suite in
   test/suite. This is the only way to exercise the things unit tests can't
   reach: activation, command registration, the webview panel, and a training
   run driven through the actual extension host. */

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/* VS Code opens a unix socket under --user-data-dir, and macOS caps socket
   paths at 103 characters. Keep the whole thing short, out of the tree, and
   unique per run (a shared --user-data-dir reads as "instance already
   running" and the launch silently no-ops). */
const tmpRoot = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
const userData = fs.mkdtempSync(path.join(tmpRoot, "skl-"));
const workspace = fs.mkdtempSync(path.join(tmpRoot, "skl-ws-"));

try {
  await runTests({
    extensionDevelopmentPath: here(".."),
    extensionTestsPath: here("./suite/index.cjs"),
    extensionTestsEnv: {
      /* An interpreter with scikit-learn in it, if the caller has one.
         Without it the end-to-end training test skips rather than fails. */
      SCIKIT_LEARNER_TEST_PYTHON: process.env.SCIKIT_LEARNER_TEST_PYTHON ?? "",
    },
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(userData, "ext")}`,
      /* Determinism: the user's own extensions must not decide whether ours
         finds a Python interpreter. */
      "--disable-extensions",
      "--disable-gpu",
      "--disable-workspace-trust",
    ],
  });
} catch (err) {
  console.error("integration tests failed:", err);
  process.exit(1);
}
