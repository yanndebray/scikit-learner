import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/* The ML layer (learner.py, airfoil.csv) lives once, in ../frontend — the
   same single-source rule the PyPI wheel follows with force-include. This
   script copies it into the extension before every build; the copies are
   gitignored. Since 0.2.0 the UI is native (trees + a bespoke plots
   webview), so app.js/styles.css are no longer synced. */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const frontend = path.resolve(root, "..", "frontend");

const copies = [
  ["py/learner.py", "python/learner.py"],
  ["data/airfoil.csv", "python/data/airfoil.csv"],
];

for (const [from, to] of copies) {
  const src = path.join(frontend, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`synced ${from} -> ${to}`);
}
