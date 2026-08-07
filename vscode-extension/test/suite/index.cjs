const path = require("node:path");
const Mocha = require("mocha");

/* Loaded by VS Code inside the extension host, so this has to be CommonJS
   and has to hand back a promise that rejects on failure. */
exports.run = function run() {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    /* A first run imports sklearn cold — seconds, not milliseconds. */
    timeout: 5 * 60 * 1000,
    slow: 5000,
  });

  mocha.addFile(path.resolve(__dirname, "extension.test.cjs"));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} test(s) failed`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
};
