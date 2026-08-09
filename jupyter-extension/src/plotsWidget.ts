import type { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

import { PLOTS_CSS, PLOTS_JS } from './generated/assets.js';
import { log } from './log.js';
import type { LearnerRuntime } from './runtime.js';
import type { LearnerSession } from './session.js';
import { CommandIDs, PLOTS_CLASS, PLOTS_ID } from './types.js';

/* ------------------------------------------------------------------ *
 *  The plots tab.                                                     *
 *                                                                     *
 *  This renders the VS Code extension's plots editor — webview/        *
 *  plots.css and webview/plots.js, byte for byte, pulled in at build  *
 *  time by scripts/gen-assets.mjs. Not a port: the same files.        *
 *                                                                     *
 *  It runs in an iframe, and that is the whole reason the reuse is    *
 *  free. plots.js was written for a VS Code webview, so it owns its   *
 *  document: it calls acquireVsCodeApi(), takes #app and #banner by   *
 *  id, and reads every colour from a --vscode-* variable. In an       *
 *  iframe all three assumptions are true again — the shim is one      *
 *  function, the ids are unambiguous, and the variables can simply be *
 *  defined. Rendering it into a Lumino widget's node instead would    *
 *  mean forking the file to scope its queries and rename its          *
 *  variables, and the two copies would drift within a release.        *
 *                                                                     *
 *  So the shell is what differs — a JupyterLab widget rather than a   *
 *  WebviewPanel — and the contract is the same one plotsPanel.ts      *
 *  implements: the host pushes a full session snapshot on every       *
 *  change, the renderer posts back user intents as commands.          *
 * ------------------------------------------------------------------ */

/** --vscode-* on the left, the --jp-* the theme actually defines on the
 *  right, first one that resolves winning. Copied as *values*: the iframe has
 *  no --jp-* variables of its own, so a var() reference would resolve to
 *  nothing and every chart would come out unstyled. */
const THEME_MAP: [string, string[], string][] = [
  ['--vscode-editor-background', ['--jp-layout-color0'], '#ffffff'],
  ['--vscode-editor-foreground', ['--jp-ui-font-color1'], '#212121'],
  ['--vscode-foreground', ['--jp-ui-font-color1'], '#212121'],
  ['--vscode-descriptionForeground', ['--jp-ui-font-color2'], '#616161'],
  ['--vscode-panel-border', ['--jp-border-color2'], '#e0e0e0'],
  ['--vscode-widget-border', ['--jp-border-color1'], '#bdbdbd'],
  ['--vscode-editorWidget-background', ['--jp-layout-color1'], '#ffffff'],
  ['--vscode-sideBar-background', ['--jp-layout-color1'], '#ffffff'],
  ['--vscode-list-hoverBackground', ['--jp-layout-color2'], '#eeeeee'],
  ['--vscode-focusBorder', ['--jp-brand-color1'], '#2196f3'],
  ['--vscode-panelTitle-activeBorder', ['--jp-brand-color1'], '#2196f3'],
  ['--vscode-textLink-foreground', ['--jp-content-link-color', '--jp-brand-color1'], '#2196f3'],
  ['--vscode-errorForeground', ['--jp-error-color1'], '#d32f2f'],
  ['--vscode-button-background', ['--jp-brand-color1'], '#2196f3'],
  ['--vscode-button-foreground', ['--jp-ui-inverse-font-color1'], '#ffffff'],
  ['--vscode-button-hoverBackground', ['--jp-brand-color0'], '#1976d2'],
  ['--vscode-button-secondaryBackground', [], 'transparent'],
  ['--vscode-button-secondaryForeground', ['--jp-ui-font-color1'], '#212121'],
  ['--vscode-button-secondaryHoverBackground', ['--jp-layout-color2'], '#eeeeee'],
  ['--vscode-dropdown-background', ['--jp-layout-color1'], '#ffffff'],
  ['--vscode-dropdown-foreground', ['--jp-ui-font-color1'], '#212121'],
  ['--vscode-dropdown-border', ['--jp-border-color1'], '#bdbdbd'],
  ['--vscode-font-family', ['--jp-ui-font-family'], 'system-ui, sans-serif'],
  ['--vscode-editor-font-family', ['--jp-code-font-family'], 'ui-monospace, Menlo, monospace']
];

/* JupyterLab has no chart palette — nothing plays the part of VS Code's
   charts.* tokens, which the bundled "Probabl Dark" theme supplies there. So
   the brand palette is carried here instead, in two versions, because a hue
   picked to sit on #040524 is illegible on white. */
const CHARTS_DARK: Record<string, string> = {
  '--vscode-charts-blue': '#4CD0FF',
  '--vscode-charts-orange': '#FF7900',
  '--vscode-charts-green': '#78F0C8',
  '--vscode-charts-red': '#FF6B6B',
  '--vscode-charts-yellow': '#E59A2F',
  '--vscode-charts-purple': '#B18EFF',
  '--vscode-charts-lines': '#2A2D6B'
};

const CHARTS_LIGHT: Record<string, string> = {
  '--vscode-charts-blue': '#0B7FA8',
  '--vscode-charts-orange': '#C25A00',
  '--vscode-charts-green': '#0E8F6E',
  '--vscode-charts-red': '#C33C3C',
  '--vscode-charts-yellow': '#976212',
  '--vscode-charts-purple': '#6B4BC0',
  '--vscode-charts-lines': '#DCDCE6'
};

/** Everything plots.js renders, in one JSON-able object. The field names are
 *  plotsPanel.ts's `snapshot()` — change one and the other has to follow. */
function snapshot(session: LearnerSession, runtime: LearnerRuntime): Record<string, unknown> {
  const ds = session.dataset;
  const selected = session.selectedRun();
  const status = runtime.status();
  return {
    /* plots.js only distinguishes 'starting' and 'failed' for its banner, and
       'idle' is neither — an unstarted kernel is the normal resting state
       here, unlike a VS Code subprocess that starts itself. */
    runtime: status.state === 'idle' ? { state: 'ready' } : status,
    training: session.training,
    dataset: ds && {
      filename: ds.filename,
      rows: ds.rows,
      taskType: ds.taskType,
      target: ds.target,
      features: ds.features,
      cvFolds: ds.cvFolds
    },
    preview: session.preview,
    runs: session.runs.map(r => ({
      key: r.key,
      name: r.name,
      category: r.category,
      status: r.status,
      metrics: r.metrics,
      fitSeconds: r.fitSeconds,
      error: r.error
    })),
    selected: selected && {
      key: selected.key,
      name: selected.name,
      category: selected.category,
      metrics: selected.metrics,
      fitSeconds: selected.fitSeconds,
      trainedAt: selected.trainedAt,
      details: selected.details ?? null
    }
  };
}

/** The iframe document. Everything is inline — no URLs to resolve, which
 *  matters because a JupyterLite site can be served from a subdirectory, from
 *  a file:// URL, or out of a service worker. */
function documentSource(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<style>${PLOTS_CSS}</style>
</head><body>
<div id="banner" class="banner" hidden></div>
<div id="app"></div>
<script>
/* The two-line shim that makes a VS Code webview script run here unmodified.
   plots.js asks for the host API once, at mount, and posts intents through
   it; the parent widget picks them out of its own message channel. */
window.acquireVsCodeApi = function () {
  return { postMessage: function (m) { parent.postMessage({ __sklearner: m }, '*'); } };
};
window.addEventListener('message', function (event) {
  if (!event.data || event.data.type !== 'theme') { return; }
  var root = document.documentElement.style;
  for (var name in event.data.vars) { root.setProperty(name, event.data.vars[name]); }
});
<\/script>
<script>${PLOTS_JS}<\/script>
</body></html>`;
}

export interface PlotsOptions {
  session: LearnerSession;
  runtime: LearnerRuntime;
  commands: CommandRegistry;
}

export class PlotsWidget extends Widget {
  constructor(options: PlotsOptions) {
    super();
    this.id = PLOTS_ID;
    this.addClass(PLOTS_CLASS);
    this._options = options;

    const frame = document.createElement('iframe');
    frame.className = 'sklearner-PlotsFrame';
    frame.setAttribute('title', 'Scikit-Learner plots');
    /* No sandbox attribute: srcdoc inherits this origin, which is what lets
       the shim above reach `parent`. Nothing untrusted runs in here — the
       document is built from two files in this bundle. */
    frame.srcdoc = documentSource();
    this.node.appendChild(frame);
    this._frame = frame;

    window.addEventListener('message', this._onMessage);
    options.session.changed.connect(this._push, this);
    options.runtime.statusChanged.connect(this._push, this);

    this.title.label = 'Scikit-Learner';
    this.title.closable = true;
    this._retitle();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    window.removeEventListener('message', this._onMessage);
    this._options.session.changed.disconnect(this._push, this);
    this._options.runtime.statusChanged.disconnect(this._push, this);
    super.dispose();
  }

  /** Re-read the host theme and push it in. Called on load and on every
   *  JupyterLab theme change; plots.js watches its own documentElement for
   *  style changes and redraws, so this alone restyles every chart. */
  syncTheme(): void {
    const host = getComputedStyle(document.body);
    const vars: Record<string, string> = {};
    for (const [target, sources, fallback] of THEME_MAP) {
      let value = '';
      for (const source of sources) {
        value = host.getPropertyValue(source).trim();
        if (value) {
          break;
        }
      }
      vars[target] = value || fallback;
    }
    /* JupyterLab stamps this on <body> for exactly this purpose. Absent (a
       front end that never set it) reads as light, which is the safer guess:
       a dark palette on a white page is unreadable, the reverse is merely
       flat. */
    const light = document.body.dataset.jpThemeLight !== 'false';
    Object.assign(vars, light ? CHARTS_LIGHT : CHARTS_DARK);
    this._post({ type: 'theme', vars });
  }

  private _push(): void {
    this._retitle();
    if (this._ready) {
      this._post({ type: 'state', state: snapshot(this._options.session, this._options.runtime) });
    }
  }

  private _retitle(): void {
    const name = this._options.session.dataset?.filename
      ?.replace(/\.csv$/i, '')
      .replace(/_dataset$/i, '');
    this.title.label = name ? `${name} — plots` : 'Scikit-Learner';
  }

  private _post(message: unknown): void {
    this._frame.contentWindow?.postMessage(message, '*');
  }

  private readonly _onMessage = (event: MessageEvent): void => {
    /* Same-origin srcdoc means every frame on the page shares our origin, so
       identity of the source window is the only reliable filter. */
    if (event.source !== this._frame.contentWindow) {
      return;
    }
    const message = (event.data as { __sklearner?: Record<string, unknown> } | null)?.__sklearner;
    if (!message) {
      return;
    }
    void this._handle(message);
  };

  private async _handle(message: Record<string, unknown>): Promise<void> {
    const { commands } = this._options;
    try {
      switch (message.cmd) {
        case 'ready':
          this._ready = true;
          /* Theme before state: plots.js reads the palette at render time, so
             the first draw has to happen with the variables already set. */
          this.syncTheme();
          this._push();
          return;
        case 'chooseDataset':
          await commands.execute(CommandIDs.chooseDataset);
          return;
        case 'loadSample':
          await commands.execute(CommandIDs.loadSample);
          return;
        case 'selectRun':
          this._options.session.selectRun(message.key as string);
          return;
        case 'exportRun':
          await commands.execute(CommandIDs.exportRun, { key: message.key as string });
          return;
        case 'openPipeline':
          await commands.execute(CommandIDs.openPipeline);
          return;
        case 'savePng':
          await commands.execute(CommandIDs.savePlot, {
            b64: message.b64 as string,
            filename: (message.filename as string) || 'plot.png'
          });
          return;
        default:
          log.warn(`plots sent an unknown command: ${String(message.cmd)}`);
      }
    } catch (err) {
      log.error(`plots ${String(message.cmd)}: ${(err as Error).message}`);
    }
  }

  private readonly _options: PlotsOptions;
  private readonly _frame: HTMLIFrameElement;
  private _ready = false;
}
