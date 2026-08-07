import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { test as realTest, after } from "node:test";

/* Exercises python/learner_server.py — the protocol layer and the learner.py
   contract behind it — against a real interpreter with scikit-learn.

   Which interpreter: $SCIKIT_LEARNER_TEST_PYTHON, or plain `python3`. When
   that interpreter has no sklearn the whole suite skips with one message,
   rather than burying the reason in a protocol timeout. */

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "python", "learner_server.py");
const python = process.env.SCIKIT_LEARNER_TEST_PYTHON || "python3";

const probe = spawnSync(python, ["-c", "import sklearn, pandas, joblib"], { stdio: "ignore" });
const usable = probe.status === 0;
if (!usable) {
  console.log(
    `# ${python} has no scikit-learn — skipping server tests. ` +
      "Point SCIKIT_LEARNER_TEST_PYTHON at an interpreter that has it."
  );
}
const test = usable ? realTest : (name) => realTest(name, { skip: "no sklearn python" }, () => {});

class Client {
  constructor() {
    this.child = spawn(python, ["-u", server], { stdio: "pipe" });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.stderr = "";
    this.child.stderr.on("data", (c) => (this.stderr += c));
    this.buf = "";
    this.waiters = [];
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.waiters.shift()?.(JSON.parse(line));
      }
    });
    this.nextId = 1;
  }
  next(timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no response within ${timeoutMs}ms\nstderr:\n${this.stderr}`)),
        timeoutMs
      );
      this.waiters.push((msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  }
  call(fn, args = [], buf) {
    const req = { id: this.nextId++, fn, args };
    if (buf !== undefined) req.buf = buf;
    this.child.stdin.write(JSON.stringify(req) + "\n");
    return this.next();
  }
  kill() {
    this.child.kill();
  }
}

const client = usable ? new Client() : null;
after(() => client?.kill());

test("server boots and reports ready", async () => {
  const hello = await client.next();
  assert.equal(
    hello.event,
    "ready",
    `expected the ready event, got ${JSON.stringify(hello)} — is scikit-learn installed in ${python}?`
  );
});

test("available_models returns both task types", async () => {
  const reg = await client.call("available_models", ["regression"]);
  assert.equal(reg.ok, true);
  assert.ok(Object.keys(reg.result.models).includes("Linear"));

  const clf = await client.call("available_models", ["classification"]);
  assert.equal(clf.ok, true);
  assert.equal(clf.result.task_type, "classification");
});

test("load_sample airfoil reads the bundled CSV (path patch works)", async () => {
  const r = await client.call("load_sample", ["airfoil"]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.success, true);
  assert.equal(r.result.stats.rows, 1503);
});

test("train linear_regression on airfoil returns metrics", async () => {
  const features = ["frequency", "angle", "length", "velocity", "thickness"];
  const r = await client.call("train", ["linear_regression", features, "target", 5, "regression"]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.result.metrics.r2 > 0, `r2 was ${r.result.metrics.r2}`);
  assert.equal(r.result.model_id, "model_1");
});

test("predictions returns aligned arrays", async () => {
  const r = await client.call("predictions", ["model_1"]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.predictions.length, r.result.actual.length);
  assert.ok(r.result.residuals.length > 0);
});

test("export_model returns joblib bytes as base64", async () => {
  const r = await client.call("export_model", ["model_1"]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.bin, "expected a bin payload");
  const bytes = Buffer.from(r.bin, "base64");
  assert.ok(bytes.length > 100, `suspiciously small export: ${bytes.length} bytes`);
});

test("classification round-trip: iris + logistic regression", async () => {
  const load = await client.call("load_sample", ["iris"]);
  assert.equal(load.ok, true);
  assert.equal(load.result.task_type, "classification");

  const feats = load.result.numeric_columns.filter((c) => c !== "target");
  const r = await client.call("train", ["logistic_regression", feats, "target", 5, "classification"]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.result.metrics.accuracy > 0.8);
  assert.equal(r.result.confusion_matrix.length, 3);
});

test("upload_csv accepts a base64 buffer (pyCallBinary path)", async () => {
  const csv = "a,b,target\n1,2,3\n4,5,9\n7,8,15\n2,1,3\n5,4,9\n";
  const r = await client.call("upload_csv", ["tiny.csv"], Buffer.from(csv).toString("base64"));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.result.stats.rows, 5);
  assert.deepEqual(r.result.numeric_columns, ["a", "b", "target"]);
});

test("ValueError surfaces as a user-facing error", async () => {
  const r = await client.call("load_sample", ["not_a_dataset"]);
  assert.equal(r.ok, false);
  assert.equal(r.user, true);
  assert.match(r.error, /Unknown dataset/);
});

test("unknown or private functions are rejected", async () => {
  const unknown = await client.call("no_such_fn", []);
  assert.equal(unknown.ok, false);
  const priv = await client.call("_ingest_df", []);
  assert.equal(priv.ok, false);
});

test("NaN in results is sanitized to null", async () => {
  const csv = "a,b\n1,\n2,5\n3,6\n";
  const up = await client.call("upload_csv", ["gaps.csv"], Buffer.from(csv).toString("base64"));
  assert.equal(up.ok, true);
  const info = await client.call("data_info", []);
  assert.equal(info.ok, true, "data_info with NaN stats must still serialize");
  const flat = JSON.stringify(info.result);
  assert.ok(!flat.includes("NaN"), "raw NaN leaked into the JSON");
});
