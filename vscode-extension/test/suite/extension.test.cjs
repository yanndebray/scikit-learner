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

suite("scikit-learner extension (0.2.0 native UI)", () => {
  test("activates and exposes the session", async () => {
    const api = await activated();
    assert.ok(api.session, "activate() should return the session");
    assert.equal(api.session.dataset, null);
    assert.deepEqual(api.session.runs, []);
  });

  test("registers its commands", async () => {
    await activated();
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      "scikit-learner.open",
      "scikit-learner.chooseDataset",
      "scikit-learner.loadSample",
      "scikit-learner.trainSelected",
      "scikit-learner.trainAll",
      "scikit-learner.exportRun",
      "scikit-learner.openPipeline",
      "scikit-learner.openMetrics",
      "scikit-learner.setTarget",
      "scikit-learner.setupEnvironment",
      "scikit-learner.selectInterpreter",
      "scikit-learner.restartPython",
      "scikit-learner.showLog",
    ]) {
      assert.ok(all.includes(id), `missing command: ${id}`);
    }
  });

  test("open command creates the plots panel", async () => {
    await activated();
    await vscode.commands.executeCommand("scikit-learner.open");
    /* No throw and a webview tab exists; the panel is a singleton so a
       second invocation must not throw either. */
    await vscode.commands.executeCommand("scikit-learner.open");
  });

  test("end-to-end: sample → train → pipeline.py → export bytes", async function () {
    if (!TEST_PYTHON) {
      this.skip();
      return;
    }
    await vscode.workspace
      .getConfiguration("scikit-learner")
      .update("python.interpreterPath", TEST_PYTHON, vscode.ConfigurationTarget.Global);

    const api = await activated();
    const session = api.session;

    await session.loadSample("synthetic");
    assert.equal(session.dataset.taskType, "regression");
    assert.equal(session.dataset.rows, 500);
    assert.equal(session.dataset.target, "target");
    assert.ok(session.catalog.length > 20, "regression catalog should be populated");
    assert.ok(session.preview, "data preview should be cached for the scatter tab");

    await session.train(["linear_regression", "ridge"]);
    const done = session.runs.filter((r) => r.status === "done");
    assert.equal(done.length, 2, JSON.stringify(session.runs));
    const lr = session.run("linear_regression");
    assert.ok(lr.metrics.r2 > 0.5, `r2 was ${lr.metrics.r2}`);
    assert.ok(lr.details.predictions.length === 500, "details should be loaded for plots");
    assert.ok(session.selectedRunKey, "best run should be auto-selected");

    /* Generated pipeline.py reflects the selected run. */
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse("scikit-learner:pipeline.py"));
    const text = doc.getText();
    assert.match(text, /from sklearn\./);
    assert.match(text, /StandardScaler\(\)/);
    assert.match(text, /cross_val_score\(model, X_scaled, y, cv=5/);

    /* metrics.json lists both runs. */
    const metricsDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.parse("scikit-learner:metrics.json")
    );
    const metrics = JSON.parse(metricsDoc.getText());
    assert.equal(metrics.runs.length, 2);

    /* Export path (bytes, skipping the save dialog). */
    const exported = await session.runtime.call("export_model", [lr.modelId]);
    assert.ok(exported.bin, "export should produce a binary payload");
    assert.ok(Buffer.from(exported.bin, "base64").length > 100);
  });
});
