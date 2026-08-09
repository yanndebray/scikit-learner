import {
  addIcon,
  downloadIcon,
  LabIcon,
  listIcon,
  PanelWithToolbar,
  ReactWidget,
  refreshIcon,
  runIcon,
  SidePanel,
  spreadsheetIcon,
  ToolbarButton
} from '@jupyterlab/ui-components';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import * as React from 'react';

import { listTables } from './contents.js';
import { log } from './log.js';
import type { LearnerRuntime } from './runtime.js';
import type { LearnerSession } from './session.js';
import { ArtifactsBody, DatasetBody, ModelsBody, RunsBody, RuntimeHeader } from './ui/sections.js';
import { CommandIDs, PANEL_CLASS, PANEL_ID } from './types.js';
import type { CommandID } from './types.js';
import type { PanelContext } from './context.js';

import flaskSvgstr from '../style/icons/flask.svg';

/* ------------------------------------------------------------------ *
 *  The side panel.                                                    *
 *                                                                     *
 *  VS Code's sidebar for this extension is one view container in the  *
 *  activity bar holding four tree views, each with its own title-bar  *
 *  actions. JupyterLab's closest thing — and it is very close — is a  *
 *  SidePanel, whose content is an accordion of PanelWithToolbar       *
 *  sections whose toolbars render into the section headers. Same      *
 *  shape, same affordances, same four names.                          *
 *                                                                     *
 *  Two differences are worth stating rather than papering over:       *
 *                                                                     *
 *   - JupyterLab has no activity bar, so the panel lives in the left  *
 *     area next to the file browser. That is where a "workbench"      *
 *     belongs here.                                                   *
 *   - A tree view gives checkboxes and twisties for free; an          *
 *     accordion section is a blank div. MODELS and RUNS draw their    *
 *     own, which is why ui/sections.tsx is longer than trees.ts.      *
 *                                                                     *
 *  Like the trees, every section is a pure renderer of the session    *
 *  and every interaction leaves through a command.                    *
 * ------------------------------------------------------------------ */

/** Registered once and shared with the plots tab, so both read as the same
 *  product. Same glyph as the VS Code activity-bar icon. */
export const learnerIcon = LabIcon.resolve({
  icon: { name: 'scikit-learner:flask', svgstr: flaskSvgstr }
});

/** A ReactWidget that draws whatever it is told, whenever it is told to. The
 *  sections have no state of their own, so this is all the machinery they
 *  need — `update()` is the only path from a model change to a repaint. */
class Body extends ReactWidget {
  constructor(private readonly _draw: () => JSX.Element) {
    super();
    /* Named so the stylesheet can give it the scrollbar. A section is a
       split-panel child with `contain: strict` and a height the accordion
       decides, so without an overflow rule on this node its content is
       silently clipped rather than scrolled. */
    this.addClass('sklearner-Body');
  }

  protected render(): JSX.Element {
    return this._draw();
  }
}

/** One accordion section: a title, a toolbar rendered into that title, and a
 *  body. The VS Code equivalent is a `views` contribution plus its
 *  `view/title` menu entries. */
class Section extends PanelWithToolbar {
  constructor(options: { label: string; className: string; draw: () => JSX.Element }) {
    super();
    this.title.label = options.label;
    this.addClass('sklearner-Section');
    this.addClass(options.className);
    this.body = new Body(options.draw);
    this.addWidget(this.body);
  }

  readonly body: Body;
}

/** The `n / total` a VS Code tree view shows next to its title. There is no
 *  such field on an accordion section, so it is a toolbar item — which lands
 *  in the same place and reads the same way. */
class Count extends ReactWidget {
  constructor(private readonly _text: () => string) {
    super();
    this.addClass('sklearner-Count');
  }

  protected render(): JSX.Element {
    return <span>{this._text()}</span>;
  }
}

export interface LearnerPanelOptions {
  session: LearnerSession;
  runtime: LearnerRuntime;
  commands: CommandRegistry;
  contents: Contents.IManager;
  /** Where the DATASET empty state looks for CSVs. Reads the file browser's
   *  current directory when there is one; '' (the root) otherwise. */
  currentDirectory(): string;
}

export class LearnerPanel extends SidePanel {
  constructor(options: LearnerPanelOptions) {
    super();
    this.id = PANEL_ID;
    this.addClass(PANEL_CLASS);
    this.title.icon = learnerIcon;
    this.title.caption = 'Scikit-Learner';

    this._options = options;
    const { session, runtime, commands } = options;

    this._context = {
      session,
      runtime,
      tables: [],
      expanded: new Set<string>(),
      collapsed: new Set<string>(),
      progressLine: null,
      execute: (command: CommandID, args?: Record<string, unknown>) => {
        void commands.execute(command, (args ?? {}) as ReadonlyPartialJSONObject).catch(err => {
          log.error(`${command}: ${(err as Error).message}`);
        });
      },
      refresh: () => this._refresh()
    };
    const ctx = this._context;

    /* ---- header: what the Python is doing ----------------------------- */

    const header = new Body(() => <RuntimeHeader ctx={ctx} />);
    header.addClass('sklearner-Runtime');
    this.header.addWidget(header);
    this._runtimeHeader = header;

    /* ---- DATASET ------------------------------------------------------- */

    const dataset = new Section({
      label: 'Dataset',
      className: 'sklearner-Dataset',
      draw: () => <DatasetBody ctx={ctx} />
    });
    dataset.toolbar.addItem(
      'choose',
      new ToolbarButton({
        icon: addIcon,
        tooltip: 'Choose a dataset…',
        onClick: () => ctx.execute(CommandIDs.chooseDataset)
      })
    );
    dataset.toolbar.addItem(
      'sample',
      new ToolbarButton({
        icon: spreadsheetIcon,
        tooltip: 'Load a sample dataset…',
        onClick: () => ctx.execute(CommandIDs.loadSample)
      })
    );

    /* ---- MODELS -------------------------------------------------------- */

    const models = new Section({
      label: 'Models',
      className: 'sklearner-Models',
      draw: () => <ModelsBody ctx={ctx} />
    });
    models.toolbar.addItem(
      'count',
      new Count(() =>
        session.catalog.length ? `${session.selected.size} / ${session.catalog.length}` : ''
      )
    );
    models.toolbar.addItem(
      'train',
      new ToolbarButton({
        icon: runIcon,
        tooltip: 'Train the selected models',
        onClick: () => ctx.execute(CommandIDs.trainSelected)
      })
    );
    models.toolbar.addItem(
      'train-all',
      new ToolbarButton({
        icon: refreshIcon,
        tooltip: 'Train every model in the catalog',
        onClick: () => ctx.execute(CommandIDs.trainAll)
      })
    );

    /* ---- RUNS ---------------------------------------------------------- */

    const runs = new Section({
      label: 'Runs',
      className: 'sklearner-Runs',
      draw: () => <RunsBody ctx={ctx} />
    });
    runs.toolbar.addItem('count', new Count(() => (session.runs.length ? `${session.runs.length}` : '')));
    runs.toolbar.addItem(
      'plots',
      new ToolbarButton({
        icon: listIcon,
        tooltip: 'Open the plots',
        onClick: () => ctx.execute(CommandIDs.openPlots)
      })
    );

    /* ---- ARTIFACTS ------------------------------------------------------ */

    const artifacts = new Section({
      label: 'Artifacts',
      className: 'sklearner-Artifacts',
      draw: () => <ArtifactsBody ctx={ctx} />
    });
    artifacts.toolbar.addItem(
      'export',
      new ToolbarButton({
        icon: downloadIcon,
        tooltip: 'Export the selected model as a .joblib',
        onClick: () => ctx.execute(CommandIDs.exportRun)
      })
    );

    this._sections = [dataset, models, runs, artifacts];
    for (const section of this._sections) {
      this.addWidget(section);
    }

    session.changed.connect(this._refresh, this);
    runtime.statusChanged.connect(this._onRuntimeStatus, this);
    runtime.progress.connect(this._onProgress, this);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._options.session.changed.disconnect(this._refresh, this);
    this._options.runtime.statusChanged.disconnect(this._onRuntimeStatus, this);
    this._options.runtime.progress.disconnect(this._onProgress, this);
    super.dispose();
  }

  /** The DATASET empty state is the only thing that reads the file browser,
   *  and it should be right whenever the panel comes into view. */
  protected onBeforeShow(): void {
    void this.refreshTables();
  }

  async refreshTables(): Promise<void> {
    const directory = this._options.currentDirectory();
    const tables = await listTables(this._options.contents, directory, 12);
    /* Only repaint when the answer changed — onBeforeShow fires often. */
    const same =
      tables.length === this._context.tables.length &&
      tables.every((table, i) => table.path === this._context.tables[i].path);
    if (!same) {
      this._context.tables = tables;
      this._refresh();
    }
  }

  private _onRuntimeStatus(): void {
    /* A status change clears whatever the last progress line said; leaving it
       up next to "ready" would be a lie about what the kernel is doing. */
    this._context.progressLine = null;
    this._refresh();
  }

  private _onProgress(_: unknown, line: string): void {
    this._context.progressLine = line;
    this._runtimeHeader.update();
  }

  private _refresh(): void {
    this._runtimeHeader.update();
    for (const section of this._sections) {
      section.body.update();
      /* The counts live in the section toolbars, which are separate widgets
         from the bodies and would otherwise keep their first value. */
      for (const item of section.toolbar.children()) {
        if (item instanceof Count) {
          item.update();
        }
      }
    }
  }

  private readonly _options: LearnerPanelOptions;
  private readonly _context: PanelContext;
  private readonly _sections: Section[];
  private readonly _runtimeHeader: Body;
}
