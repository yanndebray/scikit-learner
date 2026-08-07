const assert = require("node:assert/strict");
const vscode = require("vscode");

/* Integration tests, run inside a real extension host by test/runTests.mjs.
   The end-to-end training test needs an interpreter with scikit-learn —
   passed as $SCIKIT_LEARNER_TEST_PYTHON — and skips politely without one. */

const EXT_ID = "probabl.scikit-learner";
const TEST_PYTHON = (process.env.SCIKIT_LEARNER_TEST_PYTHON || "").trim();

async function activated() {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} not found`);
  return ext.activate();
}

suite("scikit-learner extension", () => {
  test("activates and exposes the test API", async () => {
    const api = await activated();
    assert.equal(typeof api.runtime, "function");
  });

  test("registers its commands", async () => {
    await activated();
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      "scikit-learner.open",
      "scikit-learner.setupEnvironment",
      "scikit-learner.selectInterpreter",
      "scikit-learner.restartPython",
      "scikit-learner.showLog",
    ]) {
      assert.ok(all.includes(id), `missing command: ${id}`);
    }
  });

  test("open command creates the panel and its runtime", async () => {
    const api = await activated();
    assert.equal(api.runtime(), undefined, "no runtime before the panel opens");
    await vscode.commands.executeCommand("scikit-learner.open");
    assert.ok(api.runtime(), "opening the panel should create a runtime");
    /* Re-running the command must reveal the existing panel, not stack a
       second session on the first. */
    const first = api.runtime();
    await vscode.commands.executeCommand("scikit-learner.open");
    assert.equal(api.runtime(), first);
  });

  test("end-to-end: load a sample and train through the runtime", async function () {
    if (!TEST_PYTHON) {
      this.skip();
      return;
    }
    /* Point discovery at the provided interpreter so the runtime starts
       without any first-run dialog. */
    await vscode.workspace
      .getConfiguration("scikit-learner")
      .update("python.interpreterPath", TEST_PYTHON, vscode.ConfigurationTarget.Global);

    const api = await activated();
    await vscode.commands.executeCommand("scikit-learner.open");
    const runtime = api.runtime();
    assert.ok(runtime);

    const load = await runtime.call("load_sample", ["synthetic"]);
    assert.equal(load.result.success, true);
    assert.equal(load.result.stats.rows, 500);

    const features = load.result.numeric_columns.filter((c) => c !== "target");
    const trained = await runtime.call("train", [
      "linear_regression",
      features,
      "target",
      5,
      "regression",
    ]);
    assert.ok(trained.result.metrics.r2 > 0.5, `r2 was ${trained.result.metrics.r2}`);

    const exported = await runtime.call("export_model", [trained.result.model_id]);
    assert.ok(exported.bin, "export should produce a binary payload");
    assert.ok(Buffer.from(exported.bin, "base64").length > 100);
  });
});
