import { PageConfig } from '@jupyterlab/coreutils';

/* ------------------------------------------------------------------ *
 *  Which front end is this?                                           *
 *                                                                     *
 *  One bundle serves JupyterLab and JupyterLite, and almost nothing   *
 *  in this extension needs to care — the kernel protocol, the panel   *
 *  and the plots are identical. The exception is work whose cost is   *
 *  paid on the browser's main thread.                                 *
 *                                                                     *
 *  JupyterLite's Python is Pyodide, single-threaded and in this tab.  *
 *  Fitting the whole 22-model catalogue there stops the page          *
 *  responding for minutes with nothing to cancel — the same reason    *
 *  the web app dropped its "Train All" button in v0.2.1. In           *
 *  JupyterLab the fitting happens in a real kernel process, where it  *
 *  is merely slow.                                                    *
 * ------------------------------------------------------------------ */

/** PageConfig.getOption returns '' for a key that isn't there. */
function has(option: string): boolean {
  return PageConfig.getOption(option) !== '';
}

/* Resolved once: PageConfig is populated before any plugin activates and
   never changes afterwards, and both readers must agree — a panel button
   whose command was never registered is worse than either alone. */
const LITE = has('litePluginSettings') || has('contentsAllJsonFile');

/**
 * True when running in JupyterLite.
 *
 * Both keys are written by `jupyter lite build` into `jupyter-lite.json` and
 * neither is ever set by a jupyter-server, so this is a positive test for
 * Lite rather than an absence-of-server guess. Two of them because a Lite
 * site with no `litePluginSettings` block is legal; `contentsAllJsonFile`
 * comes from the contents addon, which every built site has.
 *
 * Getting this wrong costs a toolbar button in one direction or the other,
 * never a wrong result.
 */
export function isJupyterLite(): boolean {
  return LITE;
}
