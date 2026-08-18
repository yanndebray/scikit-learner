/* Put the scikit-learn spark on the JupyterLite demo site, after the build.
 *
 * This has to be a post-build step rather than configuration. JupyterLite has
 * exactly one branding knob — `faviconUrl` in jupyter-lite.json — and it is
 * not enough on its own for two reasons:
 *
 *   - Each app ships its own jupyter-lite.json already pointing `faviconUrl`
 *     at its own ./favicon.ico, and the more specific config wins over the
 *     one in lite/jupyter-lite.json. Setting it at the root moves the /lab
 *     favicon and nothing else.
 *   - The Notebook 7 interface ignores the config once a notebook is open.
 *     `@jupyter-notebook/notebook-extension:tab-icon` rewrites the icon from
 *     static/favicons/ on every kernel status change — favicon-notebook.ico
 *     when idle, favicon-busy-1.ico when the kernel is busy — so a page under
 *     /notebooks/ reverts to the stock Jupyter icon the moment you run a cell.
 *
 * So the files themselves get replaced, which also means no config to keep in
 * sync: every path that already resolved to a Jupyter icon now resolves to the
 * spark. The PNGs and the webmanifest come from the app tarball, which is only
 * unpacked when it changes, so replacing those sticks. This script still has
 * to re-run after every `jupyter lite build` — `npm run build:lite` does both
 * in order.
 *
 * static/favicons/ needed one extra step. Those files are not in the tarball;
 * the `icons` addon copies them out of jupyter_server, and that task re-runs
 * whenever their timestamps move — which this script does to them. `jupyter
 * lite serve` re-runs the build before serving, so the stock Jupyter icons
 * came straight back the first time the site was served. lite/jupyter_lite_config.json
 * therefore turns the `icons` addon off and this script creates the directory
 * itself; nothing else in jupyterlite-core reads it.
 *
 * The busy icon is deliberately a *different* file — the same spark in grey.
 * Pointing every name at one icon would have been less code and would have
 * silently thrown away the kernel-busy signal in the notebook tab strip.
 *
 * The assets are committed under lite/branding/ rather than rendered here on
 * demand: rasterising an SVG needs a headless browser or a native image
 * library, and neither belongs in this package's build.
 */

import { copyFile, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lite = join(root, 'lite');
const branding = join(lite, 'branding');
const output = join(lite, '_output');

const SPARK = join(branding, 'spark.ico');
const SPARK_BUSY = join(branding, 'spark-busy.ico');

/** What the site name should read as, wherever it is baked into a file. */
const APP_NAME = 'Scikit-Learner';
const APP_DESCRIPTION = 'Train and compare scikit-learn models in the browser';

/* The per-app favicon.ico each app's own jupyter-lite.json points at with
   `faviconUrl: "./favicon.ico"`, plus the /lab one the root config uses. Not
   every app is present in every build — `jupyter lite build` prunes the apps
   it was not asked for — so a missing one is skipped, not an error. */
const APP_DIRS = ['lab', 'tree', 'notebooks', 'consoles', 'edit', 'repl'];

/* static/favicons/ is what the Notebook 7 tab-icon plugin reaches for. With
   the `icons` addon disabled nothing else puts files here, so this list is the
   whole directory. The names are jupyter_server's, kept verbatim because the
   plugin builds those URLs by hand; the busy trio is one animation. */
const SERVER_FAVICONS = [
  ['favicon.ico', SPARK],
  ['favicon-notebook.ico', SPARK],
  ['favicon-terminal.ico', SPARK],
  ['favicon-file.ico', SPARK],
  ['favicon-busy-1.ico', SPARK_BUSY],
  ['favicon-busy-2.ico', SPARK_BUSY],
  ['favicon-busy-3.ico', SPARK_BUSY]
];

/** The webmanifest icons — what an installed PWA and an iOS home screen use. */
const MANIFEST_ICONS = ['icon-120x120.png', 'icon-512x512.png'];

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false
  );

if (!(await exists(output))) {
  console.error(
    `brand-lite: ${relative(root, output)} does not exist.\n` +
      `Run the JupyterLite build first — or use \`npm run build:lite\`, which does both.`
  );
  process.exit(1);
}

let replaced = 0;
let skipped = 0;

/** Overwrite `dest` with `src`, but only where the build actually produced it:
 *  writing a favicon into a pruned app would leave a file nothing serves. */
async function replace(src, dest) {
  if (!(await exists(dest))) {
    skipped += 1;
    return;
  }
  await copyFile(src, dest);
  replaced += 1;
  console.log(`brand-lite: ${relative(output, dest)}`);
}

for (const app of APP_DIRS) {
  await replace(SPARK, join(output, app, 'favicon.ico'));
}

const faviconDir = join(output, 'static', 'favicons');
await mkdir(faviconDir, { recursive: true });
for (const [name, src] of SERVER_FAVICONS) {
  /* Written unconditionally, not via replace(): this directory does not exist
     until we make it, so "already there" is not the test for whether it is
     wanted. */
  await copyFile(src, join(faviconDir, name));
  replaced += 1;
  console.log(`brand-lite: ${relative(output, join(faviconDir, name))}`);
}

for (const name of MANIFEST_ICONS) {
  await replace(join(branding, name), join(output, name));
}

/* The manifest still says JupyterLite, which is the name an installed app
   would show under its icon. Patched rather than replaced wholesale so a
   change to it upstream (new icon sizes, new fields) survives. */
const manifestPath = join(output, 'manifest.webmanifest');
if (await exists(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.short_name = APP_NAME;
  manifest.name = APP_NAME;
  manifest.description = APP_DESCRIPTION;
  for (const shortcut of manifest.shortcuts ?? []) {
    if (shortcut.url === '/lab') {
      shortcut.name = APP_NAME;
      shortcut.description = `The ${APP_NAME} workbench`;
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('brand-lite: manifest.webmanifest');
  replaced += 1;
} else {
  skipped += 1;
}

console.log(
  `brand-lite: ${replaced} branded` + (skipped ? `, ${skipped} not in this build` : '')
);
