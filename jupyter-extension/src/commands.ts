import type { JupyterFrontEnd } from '@jupyterlab/application';
import { Dialog, InputDialog, Notification, showDialog } from '@jupyterlab/apputils';
import type { ICommandPalette } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';

import { bytesFromBase64 } from './kernel.js';
import { isJupyterLite } from './runtimeKind.js';
import { joinPath, listTables, parentOf, writeBase64, writeText } from './contents.js';
import type { LearnerKernel } from './kernelSession.js';
import { log } from './log.js';
import {
  generateMetrics,
  generatePipeline,
  METRICS_FILENAME,
  PIPELINE_FILENAME,
  PIPELINE_PLACEHOLDER
} from './pipeline.js';
import type { LearnerSession } from './session.js';
import { CommandIDs, SAMPLES, UserError } from './types.js';
import type { LearnerSettingsSource, TaskType } from './types.js';

/* ------------------------------------------------------------------ *
 *  The commands.                                                      *
 *                                                                     *
 *  One per entry in the VS Code extension's `contributes.commands`,   *
 *  same ids modulo the `scikit-learner:` / `scikit-learner.` prefix   *
 *  each shell wants, doing the same thing. The differences are all in *
 *  what a shell can be asked for:                                     *
 *                                                                     *
 *   VS Code                        JupyterLab                         *
 *   showQuickPick                  InputDialog.getItem                *
 *   showQuickPick(canPickMany)     InputDialog.getMultipleItems       *
 *   showSaveDialog + workspace.fs  a contents-manager write           *
 *   showInformationMessage         Notification                       *
 *   OutputChannel.show             a dialog over the ring buffer      *
 *   TextDocumentContentProvider    a real file the docmanager opens   *
 *                                                                     *
 *  Two commands here have no VS Code counterpart, both because a      *
 *  kernel is not a subprocess: "Install missing packages", which      *
 *  answers the case the VS Code extension handles by provisioning an  *
 *  environment before it ever starts Python, and "Save plot", which   *
 *  is an inline webview message there and has to be reachable from an *
 *  iframe here.                                                       *
 * ------------------------------------------------------------------ */

export interface CommandDeps {
  app: JupyterFrontEnd;
  session: LearnerSession;
  kernel: LearnerKernel;
  settings: LearnerSettingsSource;
  contents: Contents.IManager;
  /** Reveals the plots tab, creating it if it isn't open. */
  openPlots(): void;
  /** The file browser's directory, or '' where there is no file browser. */
  currentDirectory(): string;
  /** The delimited-text file selected in the file browser, if any. What the
   *  context-menu entry acts on — JupyterLab's context menu passes no
   *  argument, so the command has to ask who is selected. */
  selectedTable(): string | null;
  palette: ICommandPalette | null;
  docManager: IDocumentManager | null;
}

const CATEGORY = 'Scikit-Learner';

export function registerCommands(deps: CommandDeps): void {
  const { app, session, kernel, settings, contents, docManager } = deps;
  const { commands } = app;

  /** Registers a command with the error contract the VS Code extension's
   *  local `command()` helper implements: a UserError is something the user
   *  did and gets a warning; anything else is a bug and gets an error plus a
   *  log line. Neither is allowed to reject into the command registry, where
   *  it would surface as an unhandled rejection with no context. */
  const add = (
    id: string,
    label: string,
    run: (args: Record<string, unknown>) => unknown,
    options: { isEnabled?: () => boolean; inPalette?: boolean } = {}
  ) => {
    commands.addCommand(id, {
      label,
      caption: label,
      isEnabled: options.isEnabled,
      execute: async (args: Record<string, unknown>) => {
        try {
          return await run(args ?? {});
        } catch (err) {
          const message = (err as Error).message;
          if (err instanceof UserError) {
            Notification.warning(`Scikit-Learner: ${message}`, { autoClose: 6000 });
          } else {
            log.error(message);
            Notification.error(`Scikit-Learner: ${message}`, { autoClose: 10000 });
          }
          return undefined;
        }
      }
    });
    if (options.inPalette !== false) {
      deps.palette?.addItem({ command: id, category: CATEGORY });
    }
  };

  /** A slow session mutation with a notification attached — the analogue of
   *  the VS Code extension's `withBusy`. */
  const busy = <T>(title: string, work: () => Promise<T>): Promise<T> => {
    const promise = work();
    /* .then(() => null) because Notification.promise is typed over
       ReadonlyJSONValue and T here is anything a command returns. The
       notification never shows the value, only the message. */
    Notification.promise(promise.then(() => null), {
      pending: { message: `Scikit-Learner: ${title}`, options: { autoClose: false } },
      success: { message: () => `Scikit-Learner: ${title} — done`, options: { autoClose: 3000 } },
      /* The command wrapper already reports the failure, and two toasts for
         one error is noise. This one just has to stop spinning. */
      error: { message: () => '', options: { autoClose: 1 } }
    });
    return promise;
  };

  /** The one place that asks before touching somebody's Python environment.
   *  Wired to the runtime as well as to the command, so the question arrives
   *  the first time Python is needed and the action that triggered it carries
   *  on afterwards rather than having to be repeated. */
  const consentToInstall = async (packages: string[]): Promise<boolean> => {
    const answer = await showDialog({
      title: 'Install into this kernel?',
      body:
        /* Spaces, not commas: this is shown as the command that will run, and
           a comma-separated pip line is not one. */
        `Scikit-Learner will run \`pip install ${packages.join(' ')}\` inside the kernel ` +
        'it uses. That changes the Python environment the kernel runs in.',
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Install' })]
    });
    return answer.button.accept;
  };

  session.runtime.setInstallPrompt(probe => consentToInstall(probe.install));

  /* ---- plots ---------------------------------------------------------- */

  add(CommandIDs.openPlots, 'Open plots', () => deps.openPlots());

  /* ---- dataset -------------------------------------------------------- */

  add(CommandIDs.chooseDataset, 'Choose dataset…', async () => {
    const directory = deps.currentDirectory();
    const tables = await listTables(contents, directory, 200);
    if (tables.length === 0) {
      throw new UserError(
        `No .csv or .tsv files in ${directory || 'the root directory'}. ` +
          'Upload one with the file browser, or load a sample dataset.'
      );
    }
    const picked = await InputDialog.getItem({
      title: 'Scikit-Learner — choose a dataset',
      label: `Delimited-text files in ${directory || '/'}`,
      items: tables.map(table => table.name),
      current: 0
    });
    if (!picked.button.accept || !picked.value) {
      return;
    }
    const table = tables.find(candidate => candidate.name === picked.value);
    if (!table) {
      return;
    }
    await busy(`loading ${table.name}`, () => session.loadFile(table.path));
    deps.openPlots();
  });

  add(
    CommandIDs.loadCsv,
    'Load CSV into Scikit-Learner',
    async args => {
      const path = (args.path as string | undefined) ?? deps.selectedTable() ?? undefined;
      if (!path) {
        throw new UserError('Select a .csv or .tsv file in the file browser first.');
      }
      await busy(`loading ${path.split('/').pop()}`, () => session.loadFile(path));
      deps.openPlots();
    },
    /* Takes an argument, so it is useless from the palette — the VS Code
       manifest hides its twin the same way, with `"when": "false"`. */
    { inPalette: false }
  );

  add(CommandIDs.loadSample, 'Load a sample dataset…', async () => {
    const labels = SAMPLES.map(
      sample => `${sample.name} — ${sample.task} · ${sample.detail}`
    );
    const picked = await InputDialog.getItem({
      title: 'Scikit-Learner — sample datasets',
      label: 'Curated data to learn the workflow',
      items: labels,
      current: 0
    });
    if (!picked.button.accept || !picked.value) {
      return;
    }
    const sample = SAMPLES[labels.indexOf(picked.value)];
    if (!sample) {
      return;
    }
    await busy(`loading ${sample.name}`, () => session.loadSample(sample.key));
    deps.openPlots();
  });

  add(CommandIDs.setTarget, 'Set target column…', async () => {
    const ds = requireDataset();
    const picked = await InputDialog.getItem({
      title: 'Target column',
      label: 'The column the models learn to predict',
      items: [...ds.numericColumns],
      current: ds.target ? ds.numericColumns.indexOf(ds.target) : 0
    });
    if (picked.button.accept && picked.value) {
      session.setTarget(picked.value);
    }
  });

  add(CommandIDs.selectFeatures, 'Select feature columns…', async () => {
    const ds = requireDataset();
    const candidates = ds.numericColumns.filter(column => column !== ds.target);
    if (candidates.length === 0) {
      throw new UserError('This dataset has no numeric column left to use as a feature.');
    }
    const picked = await InputDialog.getMultipleItems({
      title: 'Feature columns',
      label: 'Everything ticked goes into X',
      items: candidates,
      defaults: candidates.filter(column => ds.features.includes(column))
    });
    if (!picked.button.accept || picked.value == null) {
      return;
    }
    if (picked.value.length === 0) {
      throw new UserError('Pick at least one feature.');
    }
    session.setFeatures(picked.value);
  });

  add(CommandIDs.setTask, 'Set task type…', async () => {
    const ds = requireDataset();
    const items = ['regression — predict a continuous value', 'classification — predict a class'];
    const picked = await InputDialog.getItem({
      title: 'Task type',
      label: 'Which family of models the catalog offers',
      items,
      current: ds.taskType === 'classification' ? 1 : 0
    });
    if (!picked.button.accept || !picked.value) {
      return;
    }
    await session.setTask(picked.value.split(' ')[0] as TaskType);
  });

  add(CommandIDs.setValidation, 'Set cross-validation folds…', async () => {
    const ds = requireDataset();
    const items = ['3', '5', '10'];
    const picked = await InputDialog.getItem({
      title: 'Cross-validation folds',
      label: 'Splits every score in the RUNS list is averaged over',
      items,
      current: Math.max(0, items.indexOf(String(ds.cvFolds)))
    });
    if (picked.button.accept && picked.value) {
      session.setCvFolds(parseInt(picked.value, 10));
    }
  });

  /* ---- training -------------------------------------------------------- */

  add(CommandIDs.trainSelected, 'Train selected models', async () => {
    deps.openPlots();
    await session.train([...session.selected]);
  });

  /* Not registered at all in JupyterLite — see runtimeKind.ts. Skipping the
     registration rather than disabling the command takes the palette entry
     with it, so there is no route to it that quietly does nothing. The panel
     drops the matching toolbar button on the same condition. */
  if (!isJupyterLite()) {
    add(CommandIDs.trainAll, 'Train all models', async () => {
      deps.openPlots();
      await session.train(session.catalog.map(model => model.key));
    });
  }

  add(
    CommandIDs.selectRun,
    'Select run',
    args => {
      session.selectRun(args.key as string);
      deps.openPlots();
    },
    { inPalette: false }
  );

  /* ---- gates ------------------------------------------------------------ */

  add(
    CommandIDs.applyGateFix,
    'Apply a review fix',
    async args => {
      const gate = session.gates.gates.find(g => g.id === args.id);
      const drop = gate?.fix?.features ?? [];
      const ds = session.dataset;
      if (!ds || drop.length === 0) {
        throw new UserError('That finding has no automatic fix.');
      }
      const kept = ds.features.filter(f => !drop.includes(f));
      if (kept.length === 0) {
        throw new UserError('Dropping those would leave no features at all.');
      }
      session.setFeatures(kept);
      Notification.success(
        `Scikit-Learner: dropped ${drop.join(', ')} from the features.`,
        { autoClose: 5000 }
      );
    },
    { inPalette: false }
  );

  add(
    CommandIDs.answerGate,
    'Answer a review question',
    async args => {
      const id = String(args.id ?? '');
      const key = String(args.key ?? '');
      if (!key) {
        return;
      }
      /* Each decide-gate answers by driving the setting the panel already
         exposes, so the answer is indistinguishable from having clicked the
         row in DATASET — and just as reversible. */
      if (id === 'G-TARGET') {
        session.setTarget(key);
      } else if (id === 'G-TASK') {
        await session.setTask(key as TaskType);
      } else if (id === 'G-CV-SPLITTER') {
        session.setCvFolds(parseInt(key, 10));
      } else {
        throw new UserError(`No action is wired for ${id}.`);
      }
    },
    { inPalette: false }
  );

  /* ---- artifacts ------------------------------------------------------- */

  add(CommandIDs.exportRun, 'Export model (joblib)', async args => {
    const key =
      (args.key as string | undefined) ?? session.selectedRunKey ?? session.bestRun()?.key;
    if (!key) {
      throw new UserError('No trained model to export.');
    }
    const b64 = await busy(`exporting ${key}.joblib`, () => session.exportBytes(key));
    const path = await outputPath(`${key}.joblib`);
    await writeBase64(contents, path, b64);
    /* Length of the decoded bytes, not of the base64 — the size shown in the
       ARTIFACTS section should be the size of the file on disk. */
    const bytes = bytesFromBase64(b64).length;
    session.noteExported(key, path, bytes);
    Notification.success(`Scikit-Learner: wrote ${path} (${(bytes / 1e6).toFixed(1)} MB)`, {
      autoClose: 5000
    });
  });

  add(CommandIDs.openPipeline, 'Open generated pipeline.py', async () => {
    const ds = session.dataset;
    const run = session.selectedRun() ?? session.bestRun();
    const source =
      ds && run ? generatePipeline(ds, run, session.model(run.key)) : PIPELINE_PLACEHOLDER;
    await openGenerated(PIPELINE_FILENAME, source);
  });

  add(CommandIDs.openMetrics, 'Open metrics.json', async () => {
    await openGenerated(METRICS_FILENAME, generateMetrics(session.dataset, session.runs));
  });

  add(
    CommandIDs.savePlot,
    'Save plot as PNG',
    async args => {
      const b64 = String(args.b64 ?? '').replace(/^data:image\/png;base64,/, '');
      if (!b64) {
        throw new UserError('There is no plot to save.');
      }
      const path = await outputPath(String(args.filename ?? 'plot.png'));
      await writeBase64(contents, path, b64);
      Notification.success(`Scikit-Learner: wrote ${path}`, { autoClose: 5000 });
    },
    { inPalette: false }
  );

  /* ---- the runtime ------------------------------------------------------ */

  add(CommandIDs.installPackages, 'Install missing packages into the kernel', async () => {
    const probe = session.runtime.probe;
    const missing = probe?.install ?? [];
    if (probe && missing.length === 0) {
      Notification.info('Scikit-Learner: the kernel already has everything it needs.', {
        autoClose: 4000
      });
      return;
    }
    const packages = missing.length > 0 ? missing : ['scikit-learn', 'pandas'];
    /* Asked rather than assumed, and only outside Pyodide: in JupyterLab the
       kernel is somebody's real environment, and installing into it is a
       change to their machine. */
    if (!probe?.pyodide && !(await consentToInstall(packages))) {
      return;
    }
    await busy(`installing ${packages.join(', ')}`, async () => {
      await session.runtime.installPackages();
      /* Nothing is usable until learner.py is loaded on top of the install,
         so finish the whole sequence rather than reporting a half-success. */
      await session.runtime.ensureReady();
    });
  });

  add(CommandIDs.selectKernel, 'Select the kernel to fit models in…', async () => {
    await kernel.select();
    /* A different kernel is a different Python: nothing probed, installed or
       booted in the old one carries over, and neither does the dataframe.
       forget() before reset() so reset() knows there is nothing to tear down
       and does not try to dispatch into a kernel that was never armed. */
    session.runtime.forget();
    await session.reset();
  });

  add(CommandIDs.restartRuntime, 'Restart the kernel', async () => {
    const answer = await showDialog({
      title: 'Restart Scikit-Learner’s kernel?',
      body: 'The loaded dataset and every trained model are discarded.',
      buttons: [Dialog.cancelButton(), Dialog.warnButton({ label: 'Restart' })]
    });
    if (!answer.button.accept) {
      return;
    }
    await session.reset();
    await kernel.restart();
    session.runtime.forget();
    Notification.info('Scikit-Learner: the kernel was restarted.', { autoClose: 4000 });
  });

  add(CommandIDs.showLog, 'Show log', async () => {
    const body = new Widget();
    body.addClass('sklearner-LogDialog');
    const pre = document.createElement('pre');
    pre.textContent = log.toText() || 'Nothing logged yet.';
    body.node.appendChild(pre);
    await showDialog({
      title: 'Scikit-Learner log',
      body,
      buttons: [Dialog.okButton({ label: 'Close' })]
    });
  });

  /* ---- helpers ---------------------------------------------------------- */

  function requireDataset() {
    const ds = session.dataset;
    if (!ds) {
      throw new UserError('Load a dataset first.');
    }
    return ds;
  }

  /** Where a generated file goes: the configured output directory, or next to
   *  the dataset when that is empty. */
  async function outputPath(filename: string): Promise<string> {
    const configured = settings.current.outputDir;
    if (configured) {
      return joinPath(configured, filename);
    }
    const from = session.dataset?.filePath;
    return joinPath(from ? parentOf(from) : deps.currentDirectory(), filename);
  }

  /** Write a generated artifact and show it.
   *
   *  The VS Code extension serves these from a virtual document provider and
   *  never touches the disk. Jupyter has no such scheme, and a real file is
   *  the better answer anyway: the file browser can see it, a notebook can
   *  `%run` it, and in JupyterLite it is the only form you can download. The
   *  cost is that it is a snapshot rather than a live view, which is what the
   *  docstring in the generated file says.
   */
  async function openGenerated(filename: string, source: string): Promise<void> {
    const path = await outputPath(filename);
    await writeText(contents, path, source);
    if (docManager) {
      docManager.openOrReveal(path);
    } else {
      Notification.info(`Scikit-Learner: wrote ${path}`, { autoClose: 5000 });
    }
  }
}
