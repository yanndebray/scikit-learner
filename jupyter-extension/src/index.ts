import { ILabShell, ILayoutRestorer } from '@jupyterlab/application';
import type { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { ICommandPalette, ISessionContextDialogs, IThemeManager } from '@jupyterlab/apputils';
import type { ISessionContext } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import type { FileBrowser } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';

import { registerCommands } from './commands.js';
import { LearnerKernel } from './kernelSession.js';
import { log } from './log.js';
import { learnerIcon, LearnerPanel } from './panel.js';
import { PlotsWidget } from './plotsWidget.js';
import { LearnerRuntime } from './runtime.js';
import { LearnerSession } from './session.js';
import { loadSettings } from './settings.js';
import { environmentItem, runsItem } from './statusbar.js';
import { ILearnerWorkbench } from './tokens.js';
import { CommandIDs, PANEL_ID, PLOTS_ID, PluginIDs } from './types.js';

/* ------------------------------------------------------------------ *
 *  Six plugins, and why they are six.                                 *
 *                                                                     *
 *  Every JupyterLab-only dependency below is `optional`, never        *
 *  `requires`, except the one token this package provides itself.     *
 *  JupyterLite serves Notebook 7 at /notebooks as well as Lab at      *
 *  /lab, and Notebook 7's shell has no left area, no status bar and   *
 *  no launcher. A plugin that requires a token nobody provides        *
 *  deactivates itself silently and takes everything downstream with   *
 *  it — which is how you ship a Lite deployment where the panel never *
 *  appears and nothing in the console says why.                       *
 *                                                                     *
 *  The split follows the VS Code extension's activate(): one place    *
 *  builds the session, one registers the sidebar, one the editor      *
 *  surface, one the commands, one the status bar. There it is five    *
 *  paragraphs of one function; here the shell insists they be         *
 *  separately activatable, which is a better fit for a front end that *
 *  comes in three shapes.                                             *
 * ------------------------------------------------------------------ */

/* Handed between plugins that happen to live in the same module. The token
   graph fixes the order — every reader depends on the plugin that writes —
   so this is a handoff rather than a global. A token for one function would
   be ceremony. */
let openPlots: (() => void) | null = null;

/* ---------------------------- the workbench ---------------------------- */

const workbenchPlugin: JupyterFrontEndPlugin<ILearnerWorkbench> = {
  id: PluginIDs.runtime,
  description:
    'The Scikit-Learner session: the model, the kernel it lives in, and the settings.',
  autoStart: true,
  provides: ILearnerWorkbench,
  optional: [ISettingRegistry, ISessionContextDialogs],
  activate: async (
    app: JupyterFrontEnd,
    registry: ISettingRegistry | null,
    sessionDialogs: ISessionContext.IDialogs | null
  ): Promise<ILearnerWorkbench> => {
    const settings = await loadSettings(registry);

    /* Nothing here starts a kernel. In JupyterLite that would mean fetching
       Pyodide and scikit-learn — tens of megabytes — because someone clicked
       a tab in the sidebar. The first call that needs Python starts it. */
    const kernel = new LearnerKernel({ app, settings, dialogs: sessionDialogs });
    const runtime = new LearnerRuntime({ kernel: kernel.supply, settings });
    const session = new LearnerSession({
      runtime,
      settings,
      contents: app.serviceManager.contents
    });

    log.info('Scikit-Learner activated');
    return { session, kernel, runtime, settings };
  }
};

/* ------------------------------- the panel ------------------------------ */

const panelPlugin: JupyterFrontEndPlugin<void> = {
  id: PluginIDs.panel,
  description: 'The side panel: dataset, models, runs and artifacts.',
  autoStart: true,
  requires: [ILearnerWorkbench],
  optional: [ILabShell, ILayoutRestorer, IDefaultFileBrowser],
  activate: (
    app: JupyterFrontEnd,
    workbench: ILearnerWorkbench,
    labShell: ILabShell | null,
    restorer: ILayoutRestorer | null,
    browser: IDefaultFileBrowser | null
  ): void => {
    /* No ILabShell means Notebook 7, which has no side areas at all.
       Standing down here is the difference between "no side panel on this
       front end" and "nothing works on this front end". */
    if (!labShell) {
      return;
    }

    const panel = new LearnerPanel({
      session: workbench.session,
      runtime: workbench.runtime,
      commands: app.commands,
      contents: app.serviceManager.contents,
      currentDirectory: () => directoryOf(browser)
    });
    app.shell.add(panel, 'left', { rank: 400 });
    restorer?.add(panel, PANEL_ID);

    /* The DATASET empty state offers the CSVs sitting next to your notebooks,
       so it has to follow the file browser rather than snapshot it once. */
    browser?.model.pathChanged.connect(() => void panel.refreshTables());
    browser?.model.refreshed.connect(() => void panel.refreshTables());
  }
};

/* ------------------------------- the plots ------------------------------ */

const plotsPlugin: JupyterFrontEndPlugin<void> = {
  id: PluginIDs.plots,
  description: 'The plots tab, rendering the VS Code extension’s charts in an iframe.',
  autoStart: true,
  requires: [ILearnerWorkbench],
  optional: [ILayoutRestorer, IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    workbench: ILearnerWorkbench,
    restorer: ILayoutRestorer | null,
    themes: IThemeManager | null
  ): void => {
    let widget: PlotsWidget | null = null;

    openPlots = () => {
      if (!widget || widget.isDisposed) {
        widget = new PlotsWidget({
          session: workbench.session,
          runtime: workbench.runtime,
          commands: app.commands
        });
        widget.title.icon = learnerIcon;
        const created = widget;
        created.disposed.connect(() => {
          if (widget === created) {
            widget = null;
          }
        });
        app.shell.add(created, 'main');
        restorer?.add(created, PLOTS_ID);
      }
      app.shell.activateById(widget.id);
    };

    /* The charts read their palette from CSS variables at draw time, so a
       theme switch has to be pushed into the iframe for them to follow. */
    themes?.themeChanged.connect(() => widget?.syncTheme());
  }
};

/* ------------------------------ the commands ---------------------------- */

const commandsPlugin: JupyterFrontEndPlugin<void> = {
  id: PluginIDs.commands,
  description: 'Palette, context-menu and panel entry points for Scikit-Learner.',
  autoStart: true,
  requires: [ILearnerWorkbench],
  optional: [ICommandPalette, IDocumentManager, IDefaultFileBrowser],
  activate: (
    app: JupyterFrontEnd,
    workbench: ILearnerWorkbench,
    palette: ICommandPalette | null,
    docManager: IDocumentManager | null,
    browser: IDefaultFileBrowser | null
  ): void => {
    registerCommands({
      app,
      session: workbench.session,
      kernel: workbench.kernel,
      settings: workbench.settings,
      contents: app.serviceManager.contents,
      openPlots: () => openPlots?.(),
      currentDirectory: () => directoryOf(browser),
      selectedTable: () => selectedTableOf(browser),
      palette,
      docManager
    });

    /* The VS Code extension puts "Load CSV" on the explorer context menu.
       This is the same entry: JupyterLab types .csv and .tsv as `csv` and
       `tsv` file types, and the selector matches the row in the listing. */
    for (const type of ['csv', 'tsv']) {
      app.contextMenu.addItem({
        command: CommandIDs.loadCsv,
        selector: `.jp-DirListing-item[data-file-type="${type}"]`,
        rank: 3
      });
    }
  }
};

/* ----------------------------- the status bar --------------------------- */

const statusBarPlugin: JupyterFrontEndPlugin<void> = {
  id: PluginIDs.statusbar,
  description: 'Kernel state and training progress in the status bar.',
  autoStart: true,
  requires: [ILearnerWorkbench],
  optional: [IStatusBar],
  activate: (
    app: JupyterFrontEnd,
    workbench: ILearnerWorkbench,
    statusBar: IStatusBar | null
  ): void => {
    if (!statusBar) {
      return;
    }
    statusBar.registerStatusItem(`${PluginIDs.statusbar}:environment`, {
      item: environmentItem(workbench.runtime, app.commands),
      align: 'right',
      rank: 99
    });
    statusBar.registerStatusItem(`${PluginIDs.statusbar}:runs`, {
      item: runsItem(workbench.session, app.commands),
      align: 'right',
      rank: 98
    });
  }
};

/* ------------------------------ the launcher ---------------------------- */

const launcherPlugin: JupyterFrontEndPlugin<void> = {
  id: PluginIDs.launcher,
  description: 'A “Scikit-Learner” card in the launcher.',
  autoStart: true,
  requires: [ILearnerWorkbench],
  optional: [ILauncher],
  activate: (
    _app: JupyterFrontEnd,
    _workbench: ILearnerWorkbench,
    launcher: ILauncher | null
  ): void => {
    /* The launcher renders on demand, so the card resolving its command later
       than this call is fine — but it must not be added where there is no
       launcher, which is every Notebook 7 page. */
    launcher?.add({ command: CommandIDs.openPlots, category: 'Other', rank: 30 });
  }
};

/* -------------------------------- helpers ------------------------------- */

function directoryOf(browser: FileBrowser | null): string {
  return browser?.model.path ?? '';
}

function selectedTableOf(browser: FileBrowser | null): string | null {
  if (!browser) {
    return null;
  }
  for (const item of browser.selectedItems()) {
    if (item.type === 'file' && /\.(csv|tsv)$/i.test(item.name)) {
      return item.path;
    }
  }
  return null;
}

const plugins: JupyterFrontEndPlugin<unknown>[] = [
  workbenchPlugin,
  panelPlugin,
  plotsPlugin,
  commandsPlugin,
  statusBarPlugin,
  launcherPlugin
];

export default plugins;
