import * as React from 'react';

import { CommandIDs, rankMetric } from '../types.js';
import type { CommandID, Run, RuntimeStatus } from '../types.js';
import type { PanelContext } from '../context.js';

/* ------------------------------------------------------------------ *
 *  The four sections.                                                 *
 *                                                                     *
 *  One component per VS Code tree view, in the same order and saying  *
 *  the same things: DATASET, MODELS, RUNS, ARTIFACTS. Where the VS    *
 *  Code extension writes a TreeItem with an icon, a label and a       *
 *  description, this writes a row with a dot, a label and a value.    *
 *  Where it attaches `item.command`, this attaches an onClick that    *
 *  executes the same command id.                                      *
 *                                                                     *
 *  That is the whole parity story, and it is deliberate: every        *
 *  interaction goes back through a command, so the palette can drive  *
 *  everything the mouse can — which is the rule the VS Code sidebar   *
 *  follows too.                                                       *
 *                                                                     *
 *  These render the model and hold no state of their own. The two     *
 *  pieces of view state that exist — which runs are expanded, which   *
 *  categories are collapsed — live in PanelContext, because they must *
 *  survive the re-render that every model change triggers.            *
 * ------------------------------------------------------------------ */

function fmt(value: unknown, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/** A label with a value on the right, optionally clickable. The workhorse:
 *  VS Code's TreeItem label + description, which is most of that sidebar. */
function Row(props: {
  label: string;
  value?: React.ReactNode;
  title?: string;
  command?: CommandID;
  args?: Record<string, unknown>;
  ctx?: PanelContext;
  className?: string;
}): JSX.Element {
  const clickable = props.command != null && props.ctx != null;
  return (
    <div
      className={`row${clickable ? ' clickable' : ''}${props.className ? ` ${props.className}` : ''}`}
      title={props.title ?? (clickable ? 'Click to change' : undefined)}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => props.ctx!.execute(props.command!, props.args) : undefined}
      onKeyDown={
        clickable
          ? event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                props.ctx!.execute(props.command!, props.args);
              }
            }
          : undefined
      }
    >
      <span className="label">{props.label}</span>
      <span className="value">{props.value}</span>
    </div>
  );
}

function Empty(props: { children: React.ReactNode }): JSX.Element {
  return <div className="empty">{props.children}</div>;
}

/* ------------------------------- DATASET -------------------------------- */

export function DatasetBody({ ctx }: { ctx: PanelContext }): JSX.Element {
  const ds = ctx.session.dataset;

  if (!ds) {
    return (
      <div className="section">
        <Empty>
          {ctx.tables.length > 0
            ? 'No dataset selected. Found next to your notebooks:'
            : 'No dataset selected — use + above, or load a sample.'}
        </Empty>
        {ctx.tables.map(table => (
          <div
            key={table.path}
            className="row clickable file-row"
            title={table.path}
            role="button"
            tabIndex={0}
            onClick={() => ctx.execute(CommandIDs.loadCsv, { path: table.path })}
          >
            <span className="label">
              <span className="glyph">▤</span>
              {table.name}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="section">
      <div className="row file-head" title={ds.filePath ?? `sample: ${ds.sampleKey ?? ''}`}>
        <span className="label strong">
          <span className="glyph accent">▤</span>
          {ds.filename}
        </span>
        <span className="value">
          {ds.rows} × {ds.columns.length}
        </span>
      </div>
      <Row
        ctx={ctx}
        command={CommandIDs.setTarget}
        label="target"
        value={ds.target ?? '—'}
      />
      <Row
        ctx={ctx}
        command={CommandIDs.selectFeatures}
        label="features"
        value={`${ds.features.length} of ${ds.numericColumns.length}`}
      />
      <Row ctx={ctx} command={CommandIDs.setTask} label="task" value={ds.taskType} />
      <Row
        ctx={ctx}
        command={CommandIDs.setValidation}
        label="validation"
        value={`${ds.cvFolds}-fold CV`}
      />
    </div>
  );
}

/* -------------------------------- MODELS -------------------------------- */

export function ModelsBody({ ctx }: { ctx: PanelContext }): JSX.Element {
  const { session } = ctx;
  if (session.catalog.length === 0) {
    return (
      <div className="section">
        <Empty>Load a dataset to see the models available for its task.</Empty>
      </div>
    );
  }

  const categories = [...new Set(session.catalog.map(m => m.category))];

  return (
    <div className="section">
      {categories.map(category => {
        const models = session.catalog.filter(m => m.category === category);
        const on = models.filter(m => session.selected.has(m.key)).length;
        const collapsed = ctx.collapsed.has(category);
        return (
          <React.Fragment key={category}>
            <div className="row category">
              <input
                type="checkbox"
                className="check"
                checked={on === models.length}
                /* Some but not all: the tri-state a VS Code tree checkbox
                   renders for a parent node, which HTML only exposes
                   imperatively. */
                ref={node => {
                  if (node) {
                    node.indeterminate = on > 0 && on < models.length;
                  }
                }}
                onChange={event => session.toggleCategory(category, event.target.checked)}
                aria-label={`Select every ${category} model`}
              />
              <button
                className="twisty-label"
                onClick={() => {
                  if (collapsed) {
                    ctx.collapsed.delete(category);
                  } else {
                    ctx.collapsed.add(category);
                  }
                  ctx.refresh();
                }}
              >
                <span className={`twisty${collapsed ? '' : ' open'}`}>▸</span>
                {category}
              </button>
              <span className="value dim">
                {on}/{models.length}
              </span>
            </div>
            {!collapsed &&
              models.map(model => (
                <label className="row model" key={model.key} title={paramsTooltip(model.params)}>
                  <input
                    type="checkbox"
                    className="check"
                    checked={session.selected.has(model.key)}
                    onChange={event => session.toggleModel(model.key, event.target.checked)}
                  />
                  <span className="label">{model.name}</span>
                </label>
              ))}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function paramsTooltip(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  return entries.length === 0
    ? 'no hyperparameters'
    : entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n');
}

/* --------------------------------- RUNS --------------------------------- */

/** The order the VS Code RunsTree sorts by: what is happening now, then what
 *  is about to, then the finished ones best-first, then the failures. */
function runOrder(a: Run, b: Run, metric: string): number {
  const rank: Record<string, number> = { running: 0, queued: 1, done: 2, failed: 3 };
  return (
    rank[a.status] - rank[b.status] ||
    (b.metrics?.[metric] ?? -1) - (a.metrics?.[metric] ?? -1)
  );
}

export function RunsBody({ ctx }: { ctx: PanelContext }): JSX.Element {
  const { session } = ctx;
  if (session.runs.length === 0) {
    return (
      <div className="section">
        <Empty>
          Nothing trained yet. Tick some models above and press ▶, or train the whole catalog.
        </Empty>
      </div>
    );
  }

  const metric = rankMetric(session.dataset?.taskType);
  const runs = [...session.runs].sort((a, b) => runOrder(a, b, metric));

  return (
    <div className="section">
      {runs.map(run => {
        const expanded = ctx.expanded.has(run.key);
        const selected = run.key === session.selectedRunKey;
        const params = session.model(run.key)?.params ?? {};
        return (
          <React.Fragment key={run.key}>
            <div
              className={`row run status-${run.status}${selected ? ' selected' : ''}`}
              title={run.error ?? `${run.category}${run.fitSeconds != null ? ` · ${run.fitSeconds.toFixed(2)}s train` : ''}`}
            >
              <button
                className="twisty-label"
                onClick={() => {
                  ctx.execute(CommandIDs.selectRun, { key: run.key });
                  if (run.status === 'done') {
                    if (expanded) {
                      ctx.expanded.delete(run.key);
                    } else {
                      ctx.expanded.add(run.key);
                    }
                  }
                  ctx.refresh();
                }}
              >
                <span className={`twisty${expanded ? ' open' : ''}`}>
                  {run.status === 'done' ? '▸' : ''}
                </span>
                <span className={`dot ${run.status}${selected ? ' current' : ''}`} />
                {run.name}
              </button>
              <span className="value">
                {run.status === 'done'
                  ? fmt(run.metrics?.[metric])
                  : run.status === 'running'
                    ? 'training…'
                    : run.status}
              </span>
              {run.status === 'done' && (
                <button
                  className="inline-action"
                  title="Export this model as a .joblib"
                  onClick={event => {
                    event.stopPropagation();
                    ctx.execute(CommandIDs.exportRun, { key: run.key });
                  }}
                >
                  ↓
                </button>
              )}
            </div>
            {expanded && run.status === 'done' && (
              <div className="detail">
                {Object.entries(run.metrics ?? {}).map(([name, value]) => (
                  <Row
                    key={name}
                    label={name}
                    value={typeof value === 'number' ? value.toFixed(4) : String(value)}
                  />
                ))}
                {Object.keys(params).length > 0 && (
                  <>
                    <div className="detail-head">hyperparameters</div>
                    {Object.entries(params).map(([name, value]) => (
                      <Row key={name} label={name} value={JSON.stringify(value)} />
                    ))}
                  </>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ------------------------------- ARTIFACTS ------------------------------ */

export function ArtifactsBody({ ctx }: { ctx: PanelContext }): JSX.Element {
  const { session } = ctx;
  const done = session.runs.filter(r => r.status === 'done');
  if (done.length === 0) {
    return (
      <div className="section">
        <Empty>
          Train a model and the generated <code>pipeline.py</code>, its metrics and the fitted
          models show up here as real files.
        </Empty>
      </div>
    );
  }

  return (
    <div className="section">
      <Row
        ctx={ctx}
        command={CommandIDs.openPipeline}
        label="pipeline.py"
        value="generated"
        title="The sklearn code equivalent to the selected run"
        className="artifact code"
      />
      <Row
        ctx={ctx}
        command={CommandIDs.openMetrics}
        label="metrics.json"
        value="generated"
        title="Every finished run, as JSON"
        className="artifact json"
      />
      {done.map(run => (
        <Row
          key={run.key}
          ctx={ctx}
          command={CommandIDs.exportRun}
          args={{ key: run.key }}
          label={`${run.key}.joblib`}
          value={run.exportedBytes ? `${(run.exportedBytes / 1e6).toFixed(1)} MB` : 'click to export'}
          title={run.exportedPath ?? 'Fit on the full dataset, with its scaler'}
          className="artifact model"
        />
      ))}
    </div>
  );
}

/* -------------------------------- header -------------------------------- */

/** The runtime line at the top of the panel.
 *
 *  The VS Code extension puts this in the status bar and nowhere else, which
 *  works because its Python either starts or the extension prompts modally.
 *  Here the first run in JupyterLite downloads scikit-learn into the browser,
 *  and in JupyterLab a kernel can be missing packages the user has to agree
 *  to install — neither is a status-bar-sized event, so it also gets a line
 *  in the panel with the fix attached.
 */
export function RuntimeHeader({ ctx }: { ctx: PanelContext }): JSX.Element | null {
  const status: RuntimeStatus = ctx.runtime.status();
  const versions = ctx.runtime.versions;

  if (status.state === 'idle') {
    return (
      <div className="runtime idle">
        <span className="dot idle" />
        <span className="what">Kernel not started</span>
      </div>
    );
  }

  if (status.state === 'ready') {
    return (
      <div className="runtime ready" title={status.detail}>
        <span className="dot done" />
        <span className="what">{versions.kernel ?? 'Python'}</span>
        {versions.sklearn && <span className="version">scikit-learn {versions.sklearn}</span>}
      </div>
    );
  }

  if (status.state === 'needs-packages') {
    return (
      <div className="runtime warn">
        <span className="dot failed" />
        <span className="what">{status.message}</span>
        <button className="fix" onClick={() => ctx.execute(CommandIDs.installPackages)}>
          Install {status.missing.join(', ')}
        </button>
      </div>
    );
  }

  if (status.state === 'failed') {
    return (
      <div className="runtime error">
        <span className="dot failed" />
        <span className="what">{status.message}</span>
        <button className="fix" onClick={() => ctx.execute(CommandIDs.showLog)}>
          Show log
        </button>
      </div>
    );
  }

  return (
    <div className="runtime busy">
      <span className="dot running" />
      <span className="what">{ctx.progressLine ?? status.message}</span>
    </div>
  );
}
