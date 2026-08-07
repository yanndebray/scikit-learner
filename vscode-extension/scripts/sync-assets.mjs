import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/* The app's UI (app.js, styles.css) and its Python side (learner.py,
   airfoil.csv) live once, in ../frontend — the same single-source rule the
   PyPI wheel follows with force-include. This script copies them into the
   extension before every build; the copies are gitignored. */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const frontend = path.resolve(root, "..", "frontend");

const copies = [
  ["js/app.js", "media/app/app.js"],
  ["css/styles.css", "media/app/styles.css"],
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
