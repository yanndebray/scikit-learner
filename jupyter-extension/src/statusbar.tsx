import { ReactWidget } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import * as React from 'react';

import type { LearnerRuntime } from './runtime.js';
import type { LearnerSession } from './session.js';
import { CommandIDs, rankMetric } from './types.js';

/* ------------------------------------------------------------------ *
 *  The status bar.                                                    *
 *                                                                     *
 *  Same two items as the VS Code extension's src/statusbar.ts, in the *
 *  same order and saying the same things: the Python on the left of   *
 *  the pair, and either training progress or the best score so far on *
 *  the right. Both are clickable and both hide when they have nothing *
 *  to say, which is the rule that keeps a status bar readable.        *
 * ------------------------------------------------------------------ */

class StatusItem extends ReactWidget {
  constructor(private readonly _draw: () => JSX.Element | null) {
    super();
    this.addClass('sklearner-StatusItem');
  }

  protected render(): JSX.Element | null {
    return this._draw();
  }
}

export function environmentItem(
  runtime: LearnerRuntime,
  commands: CommandRegistry
): ReactWidget {
  const item = new StatusItem(() => {
    const status = runtime.status();
    const versions = runtime.versions;

    if (status.state === 'idle') {
      return null;
    }
    if (status.state === 'ready') {
      return (
        <span
          className="sklearner-Status ready"
          title={`${status.detail}${versions.sklearn ? `\nscikit-learn ${versions.sklearn}` : ''}\nClick to change kernel`}
          /* Same target as the VS Code extension's environment item, which
             opens the interpreter picker: this is where you go when the
             answer is "wrong Python". */
          onClick={() => void commands.execute(CommandIDs.selectKernel)}
        >
          <span className="dot done" />
          Python {versions.python ?? ''}
        </span>
      );
    }
    if (status.state === 'failed' || status.state === 'needs-packages') {
      return (
        <span
          className="sklearner-Status failed"
          title={status.message}
          onClick={() => {
            void commands.execute(
              status.state === 'needs-packages' ? CommandIDs.installPackages : CommandIDs.showLog
            );
          }}
        >
          <span className="dot failed" />
          Python
        </span>
      );
    }
    return (
      <span className="sklearner-Status busy" title={status.message}>
        <span className="dot running" />
        {status.message}
      </span>
    );
  });

  runtime.statusChanged.connect(() => item.update());
  return item;
}

export function runsItem(session: LearnerSession, commands: CommandRegistry): ReactWidget {
  const item = new StatusItem(() => {
    if (session.training) {
      const queued = session.runs.filter(run => session.queue.includes(run.key));
      const finished = queued.filter(
        run => run.status === 'done' || run.status === 'failed'
      ).length;
      const total = session.queue.length;
      const running = queued.find(run => run.status === 'running');
      return (
        <span
          className="sklearner-Status busy"
          onClick={() => void commands.execute(CommandIDs.openPlots)}
        >
          <span className="dot running" />
          Training {Math.min(finished + 1, total)} of {total}
          {running ? ` · ${running.name}` : ''}
        </span>
      );
    }

    const done = session.runs.filter(run => run.status === 'done');
    const best = session.bestRun();
    if (done.length === 0 || !best) {
      return null;
    }
    const metric = rankMetric(session.dataset?.taskType);
    return (
      <span
        className="sklearner-Status best"
        title={`Best: ${best.name}`}
        onClick={() => void commands.execute(CommandIDs.openPlots)}
      >
        <span className="dot done" />
        {done.length} run{done.length === 1 ? '' : 's'} · best{' '}
        {(best.metrics?.[metric] ?? 0).toFixed(3)}
      </span>
    );
  });

  session.changed.connect(() => item.update());
  return item;
}
