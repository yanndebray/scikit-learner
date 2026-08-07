/**
 * plots.js — the Scikit-Learner plots editor (design 1a–1c).
 *
 * A pure renderer: the extension host pushes the session snapshot, this file
 * draws it. Charts are hand-rolled SVG colored from the active VS Code
 * theme's --vscode-* variables (charts.*, chrome tokens) — no Plotly, no
 * external anything. The bundled "Probabl Dark" theme supplies the brand
 * look. Local UI state (active tab, plot-controls popover) lives here;
 * everything that mutates the session goes back to the host as a command
 * message.
 */

(() => {
  const vscode = acquireVsCodeApi();

  /* Colors come from the active VS Code theme (charts.* + chrome tokens),
     read at render time so a theme switch restyles every chart live. The
     bundled "Probabl Dark" theme supplies the brand palette. */
  let P = {};
  let SERIES = [];
  let MONO = "ui-monospace, Menlo, monospace";
  let SANS = "system-ui, sans-serif";

  function refreshPalette() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => {
      const value = cs.getPropertyValue(name).trim();
      return value || fallback;
    };
    P = {
      bg: v("--vscode-editor-background", "#1e1e1e"),
      fg: v("--vscode-editor-foreground", "#cccccc"),
      muted: v("--vscode-descriptionForeground", "#8c8ea8"),
      grid: v("--vscode-charts-lines", v("--vscode-panel-border", "#44445588")),
      axis: v("--vscode-panel-border", "#444455"),
      blue: v("--vscode-charts-blue", "#4CD0FF"),
      orange: v("--vscode-charts-orange", "#FF7900"),
      green: v("--vscode-charts-green", "#78F0C8"),
      red: v("--vscode-charts-red", "#FF6B6B"),
      yellow: v("--vscode-charts-yellow", "#E59A2F"),
      purple: v("--vscode-charts-purple", "#B18EFF"),
    };
    SERIES = [P.blue, P.orange, P.green, P.purple, P.yellow, P.red];
    MONO = v("--vscode-editor-font-family", "ui-monospace, Menlo, monospace").replaceAll('"', "'");
    SANS = v("--vscode-font-family", "system-ui, sans-serif").replaceAll('"', "'");
  }

  /* VS Code swaps the --vscode-* variables in place on theme change; watch
     the root element and re-render so the charts follow immediately. */
  new MutationObserver(() => {
    if (state) render();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  new MutationObserver(() => {
    if (state) render();
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  let state = null;
  const ui = {
    tab: null,
    popover: false,
    colourBy: "actual", // actual | predicted
    ref45: true,
    jitter: false,
    scatterX: null,
    scatterY: null,
  };

  /* Close the plot-controls popover on any click outside it or its button. */
  document.addEventListener("click", (e) => {
    if (!ui.popover) return;
    if (e.target.closest("#popover") || e.target.closest("#gear")) return;
    ui.popover = false;
    render();
  });

  const app = document.getElementById("app");
  const banner = document.getElementById("banner");

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") {
      state = e.data.state;
      render();
    }
  });
  vscode.postMessage({ cmd: "ready" });

  /* ---- helpers -------------------------------------------------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
  function fmt(v, digits = 3) {
    return typeof v === "number" && isFinite(v) ? v.toFixed(digits) : "—";
  }
  /* Deterministic pseudo-random in [-1, 1] per index — for the jitter
     toggle; Math.random would make the plot shimmer on every render. */
  function noise(i, salt) {
    const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }
  /* Theme colors arrive as #rgb, #rrggbb or rgb()/rgba() — parse them all. */
  function parseColor(c) {
    c = c.trim();
    if (c.startsWith("#")) {
      if (c.length >= 7) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
      return [1, 2, 3].map((i) => parseInt(c[i] + c[i], 16));
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) return m[1].split(",").slice(0, 3).map((s) => Math.round(parseFloat(s)));
    return [128, 128, 128];
  }
  function lerpColor(a, b, t) {
    const pa = parseColor(a);
    const pb = parseColor(b);
    const q = Math.max(0, Math.min(1, t));
    return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * q)).join(",")})`;
  }
  /* Continuous colour ramp: theme blue → theme orange. */
  function heat(t) {
    return lerpColor(P.blue, P.orange, t);
  }
  function niceTicks(min, max, count = 5) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / (count - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) ticks.push(+v.toPrecision(12));
    return ticks;
  }
  function tickLabel(v) {
    if (Math.abs(v) >= 10000 || (Math.abs(v) < 0.001 && v !== 0)) return v.toExponential(0);
    return +v.toPrecision(6);
  }
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  /* ---- chart frame ----------------------------------------------------- */

  const W = 820, H = 470, ML = 70, MR = 20, MT = 30, MB = 40;

  function frame(xTicks, yTicks, xScale, yScale, xLabel, yLabel) {
    let g = `<g stroke="${P.grid}" stroke-width="1">`;
    for (const t of yTicks) g += `<line x1="${ML}" y1="${yScale(t)}" x2="${W - MR}" y2="${yScale(t)}"></line>`;
    g += `</g>`;
    let axes = `<g stroke="${P.axis}" stroke-width="1">` +
      `<line x1="${ML}" y1="${MT}" x2="${ML}" y2="${H - MB}"></line>` +
      `<line x1="${ML}" y1="${H - MB}" x2="${W - MR}" y2="${H - MB}"></line></g>`;
    let labels = `<g fill="${P.muted}" font-family="${MONO}" font-size="11">`;
    for (const t of yTicks) labels += `<text x="${ML - 12}" y="${yScale(t) + 4}" text-anchor="end">${tickLabel(t)}</text>`;
    for (const t of xTicks) labels += `<text x="${xScale(t)}" y="${H - MB + 22}" text-anchor="middle">${tickLabel(t)}</text>`;
    labels += `</g>`;
    const xl = `<text x="${(ML + W - MR) / 2}" y="${H - 4}" text-anchor="middle" fill="${P.muted}" font-family="${SANS}" font-size="12">${esc(xLabel)}</text>`;
    const yl = `<text x="20" y="${(MT + H - MB) / 2}" text-anchor="middle" fill="${P.muted}" font-family="${SANS}" font-size="12" transform="rotate(-90 20 ${(MT + H - MB) / 2})">${esc(yLabel)}</text>`;
    return g + axes + labels + xl + yl;
  }

  function scales(xs, ys) {
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const xTicks = niceTicks(xmin, xmax);
    const yTicks = niceTicks(ymin, ymax);
    const x0 = xTicks[0], x1 = xTicks[xTicks.length - 1];
    const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];
    const xScale = (v) => ML + ((v - x0) / (x1 - x0 || 1)) * (W - ML - MR);
    const yScale = (v) => H - MB - ((v - y0) / (y1 - y0 || 1)) * (H - MB - MT);
    return { xTicks, yTicks, xScale, yScale };
  }

  function svgWrap(inner) {
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="${P.bg}"></rect>${inner}</svg>`;
  }

  /* Class labels can be strings; charts need numbers. */
  function numeric(values, classLabels) {
    if (values.length && typeof values[0] === "number") return values;
    const labels = classLabels || [...new Set(values)];
    return values.map((v) => labels.indexOf(v));
  }

  /* ---- charts ---------------------------------------------------------- */

  function scatterChart() {
    const p = state.preview;
    if (!p || !p.columns.length) return { hint: "No numeric columns to plot." };
    const cols = p.columns;
    if (!ui.scatterX || !cols.includes(ui.scatterX)) ui.scatterX = cols[0];
    if (!ui.scatterY || !cols.includes(ui.scatterY)) ui.scatterY = cols[1] || cols[0];
    const xs = p.data[ui.scatterX] || [];
    const ys = p.data[ui.scatterY] || [];
    const sel = state.selected;
    const colourVals =
      ui.colourBy === "predicted" && sel && sel.details
        ? numeric(sel.details.predictions, sel.details.classLabels)
        : p.data[state.dataset.target] || xs;
    const cmin = Math.min(...colourVals), cmax = Math.max(...colourVals);
    const { xTicks, yTicks, xScale, yScale } = scales(xs, ys);
    let dots = "";
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      const t = (colourVals[i % colourVals.length] - cmin) / (cmax - cmin || 1);
      dots += `<circle cx="${xScale(xs[i]).toFixed(1)}" cy="${yScale(ys[i]).toFixed(1)}" r="3.4" fill="${heat(t)}" fill-opacity="0.72"></circle>`;
    }
    return {
      svg: svgWrap(frame(xTicks, yTicks, xScale, yScale, ui.scatterX, ui.scatterY) + dots),
      title: `Scatter — ${ui.scatterX} vs ${ui.scatterY}`,
      meta: `${n} of ${state.dataset.rows} rows · coloured by ${ui.colourBy === "predicted" ? "predicted" : esc(state.dataset.target ?? "x")}`,
    };
  }

  function predVsActual() {
    const sel = state.selected;
    if (!sel || !sel.details) return { hint: "Train a model to see predictions." };
    const labels = sel.details.classLabels;
    const actual = numeric(sel.details.actual, labels);
    const pred = numeric(sel.details.predictions, labels);
    const all = actual.concat(pred);
    const { xTicks, yTicks, xScale, yScale } = scales(all, all);
    const j = ui.jitter ? (xTicks[1] - xTicks[0]) * 0.08 : 0;
    let dots = "";
    for (let i = 0; i < actual.length; i++) {
      dots += `<circle cx="${xScale(actual[i] + j * noise(i, 1)).toFixed(1)}" cy="${yScale(pred[i] + j * noise(i, 2)).toFixed(1)}" r="3.4" fill="${P.blue}" fill-opacity="0.72"></circle>`;
    }
    let ref = "";
    if (ui.ref45) {
      const lo = Math.max(xTicks[0], yTicks[0]);
      const hi = Math.min(xTicks[xTicks.length - 1], yTicks[yTicks.length - 1]);
      ref = `<line x1="${xScale(lo)}" y1="${yScale(lo)}" x2="${xScale(hi)}" y2="${yScale(hi)}" stroke="${P.orange}" stroke-width="1.5" stroke-dasharray="5 5" opacity="0.8"></line>`;
    }
    const tgt = state.dataset.target ?? "target";
    return {
      svg: svgWrap(frame(xTicks, yTicks, xScale, yScale, `Actual — ${tgt}`, "Predicted") + ref + dots),
      title: `Predicted vs actual — ${sel.name}`,
      meta: `${actual.length} samples · full fit`,
    };
  }

  function residualsChart() {
    const sel = state.selected;
    if (!sel || !sel.details || !sel.details.residuals) return { hint: "Train a regression model to see residuals." };
    const pred = sel.details.predictions;
    const res = sel.details.residuals;
    const { xTicks, yTicks, xScale, yScale } = scales(pred, res.concat([0]));
    const rmax = Math.max(...res.map((r) => Math.abs(r))) || 1;
    let dots = "";
    for (let i = 0; i < pred.length; i++) {
      dots += `<circle cx="${xScale(pred[i]).toFixed(1)}" cy="${yScale(res[i]).toFixed(1)}" r="3.4" fill="${lerpColor(P.green, P.orange, Math.abs(res[i]) / rmax)}" fill-opacity="0.72"></circle>`;
    }
    const zero = `<line x1="${ML}" y1="${yScale(0)}" x2="${W - MR}" y2="${yScale(0)}" stroke="${P.orange}" stroke-width="1.5" stroke-dasharray="5 5" opacity="0.8"></line>`;
    return {
      svg: svgWrap(frame(xTicks, yTicks, xScale, yScale, "Predicted", "Residual") + zero + dots),
      title: `Residuals — ${sel.name}`,
      meta: `${pred.length} samples`,
    };
  }

  function confusionChart() {
    const sel = state.selected;
    if (!sel || !sel.details || !sel.details.confusion) return { hint: "Train a classification model to see the confusion matrix." };
    const cm = sel.details.confusion;
    const labels = (sel.details.classLabels || cm.map((_, i) => i)).map(String);
    const n = cm.length;
    const size = Math.min(W - ML - MR, H - MT - MB);
    const cell = size / n;
    const ox = ML + (W - ML - MR - size) / 2;
    const oy = MT;
    const max = Math.max(...cm.flat()) || 1;
    let cells = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const v = cm[r][c];
        const t = v / max;
        cells += `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell - 2}" height="${cell - 2}" rx="2" fill="${lerpColor(P.bg, P.blue, t)}"></rect>`;
        cells += `<text x="${ox + c * cell + (cell - 2) / 2}" y="${oy + r * cell + (cell - 2) / 2 + 5}" text-anchor="middle" fill="${t > 0.55 ? P.bg : P.fg}" font-family="${MONO}" font-size="${n > 6 ? 10 : 14}">${v}</text>`;
      }
    }
    let axisLabels = `<g fill="${P.muted}" font-family="${MONO}" font-size="${n > 6 ? 9 : 11}">`;
    for (let i = 0; i < n; i++) {
      axisLabels += `<text x="${ox + i * cell + cell / 2}" y="${oy + size + 16}" text-anchor="middle">${esc(labels[i])}</text>`;
      axisLabels += `<text x="${ox - 10}" y="${oy + i * cell + cell / 2 + 4}" text-anchor="end">${esc(labels[i])}</text>`;
    }
    axisLabels += `</g>`;
    const cap = `<text x="${ox + size / 2}" y="${H - 4}" text-anchor="middle" fill="${P.muted}" font-family="${SANS}" font-size="12">Predicted</text>` +
      `<text x="${ox - 46}" y="${oy + size / 2}" text-anchor="middle" fill="${P.muted}" font-family="${SANS}" font-size="12" transform="rotate(-90 ${ox - 46} ${oy + size / 2})">Actual</text>`;
    return {
      svg: svgWrap(cells + axisLabels + cap),
      title: `Confusion matrix — ${sel.name}`,
      meta: `${n} classes`,
    };
  }

  function rocChart() {
    const sel = state.selected;
    const roc = sel && sel.details && sel.details.roc;
    if (!roc) return { hint: "No ROC curve — the model may not expose probabilities." };
    const { xTicks, yTicks, xScale, yScale } = scales([0, 1], [0, 1]);
    const multi = Array.isArray(roc.fpr[0]);
    const curves = multi ? roc.fpr.map((f, i) => ({ f, t: roc.tpr[i], auc: roc.auc[i] })) : [{ f: roc.fpr, t: roc.tpr, auc: roc.auc }];
    let paths = "";
    let legend = "";
    curves.forEach((c, i) => {
      const color = SERIES[i % SERIES.length];
      const d = c.f.map((x, k) => `${k ? "L" : "M"}${xScale(x).toFixed(1)},${yScale(c.t[k]).toFixed(1)}`).join("");
      paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2"></path>`;
      const label = multi ? `class ${sel.details.classLabels ? esc(String(sel.details.classLabels[i])) : i}` : "ROC";
      legend += `<text x="${W - MR - 10}" y="${H - MB - 14 - (curves.length - 1 - i) * 16}" text-anchor="end" fill="${color}" font-family="${MONO}" font-size="11">${label} · AUC ${fmt(c.auc)}</text>`;
    });
    const diag = `<line x1="${xScale(0)}" y1="${yScale(0)}" x2="${xScale(1)}" y2="${yScale(1)}" stroke="${P.muted}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"></line>`;
    return {
      svg: svgWrap(frame(xTicks, yTicks, xScale, yScale, "False positive rate", "True positive rate") + diag + paths + legend),
      title: `ROC — ${sel.name}`,
      meta: multi ? "one-vs-rest per class" : `AUC ${fmt(curves[0].auc)}`,
    };
  }

  /* ---- comparison table ------------------------------------------------ */

  function compareHtml() {
    const isClf = state.dataset.taskType === "classification";
    const metric = isClf ? "cv_accuracy_mean" : "cv_r2_mean";
    const cols = isClf ? ["ACCURACY", "F1"] : ["R²", "RMSE"];
    const runs = [...state.runs].sort((a, b) => ((b.metrics || {})[metric] ?? -1) - ((a.metrics || {})[metric] ?? -1));
    const best = runs.find((r) => r.status === "done");
    const rows = runs.map((r) => {
      const m = r.metrics || {};
      const v1 = isClf ? m.accuracy : m.r2;
      const v2 = isClf ? m.f1 : m.rmse;
      const status = r.status === "done" ? "done" : r.status === "running" ? "training…" : r.status;
      return `<tr data-key="${esc(r.key)}" class="${r.key === (state.selected && state.selected.key) ? "selected" : ""}">
        <td>${esc(r.name)}</td>
        <td class="${r === best ? "best" : ""}">${fmt(v1)}</td>
        <td>${fmt(v2)}</td>
        <td>${r.fitSeconds != null ? r.fitSeconds.toFixed(2) : "—"}</td>
        <td class="status-${r.status}">${esc(status)}</td>
      </tr>`;
    }).join("");
    return `<table class="compare">
      <thead><tr><th>MODEL</th><th>${cols[0]}</th><th>${cols[1]}</th><th>FIT (S)</th><th>STATUS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /* ---- layout ----------------------------------------------------------- */

  const TAB_LABELS = {
    scatter: "Scatter",
    pred: "Predicted vs actual",
    residuals: "Residuals",
    confusion: "Confusion matrix",
    roc: "ROC",
    compare: "Comparison",
  };

  function tabsFor() {
    return state.dataset.taskType === "classification"
      ? ["scatter", "pred", "confusion", "roc", "compare"]
      : ["scatter", "pred", "residuals", "compare"];
  }

  function render() {
    if (!state) return;
    refreshPalette();
    renderBanner();
    if (!state.dataset) {
      renderEmpty();
      return;
    }
    const tabs = tabsFor();
    if (!ui.tab || !tabs.includes(ui.tab)) ui.tab = state.runs.some((r) => r.status === "done") ? "pred" : "scatter";

    const chart =
      ui.tab === "compare" ? null :
      ui.tab === "scatter" ? scatterChart() :
      ui.tab === "pred" ? predVsActual() :
      ui.tab === "residuals" ? residualsChart() :
      ui.tab === "confusion" ? confusionChart() : rocChart();

    /* Run identity + timing used to live in the inspector column; now it
       rides the plot header's meta line (the sidebar RUNS view carries the
       full metrics/hyperparameters). */
    if (chart && !chart.hint && state.selected && ui.tab !== "scatter" && ui.tab !== "compare") {
      const sel = state.selected;
      chart.meta += ` · ${relTime(sel.trainedAt)}${sel.fitSeconds != null ? ` · ${sel.fitSeconds.toFixed(2)}s train` : ""}`;
    }

    const tabButtons = tabs.map((t) =>
      `<button class="tab ${t === ui.tab ? "active" : ""}" data-tab="${t}">${TAB_LABELS[t]}</button>`
    ).join("");
    const hasControls = ui.tab === "scatter" || ui.tab === "pred";
    const gear = hasControls
      ? `<button class="action ${ui.popover ? "active" : ""}" id="gear" title="Plot controls">⚙ Plot</button>` : "";
    const savePng = ui.tab !== "compare" && chart && chart.svg
      ? `<button class="action" id="save-png">↓ Save PNG</button>` : "";

    const body = ui.tab === "compare"
      ? `<div class="plot-area"><div class="plot-head"><div class="title">Comparison — ${state.dataset.cvFolds}-fold cross-validation</div></div><div style="overflow:auto; min-height:0;">${compareHtml()}</div></div>`
      : chart.hint
        ? `<div class="plot-hint">${esc(chart.hint)}</div>`
        : `<div class="plot-area"><div class="plot-head"><div class="title" title="${esc(chart.title)}">${chart.title}</div><div class="meta">${chart.meta}</div></div><div class="plot-canvas" id="plot-canvas">${chart.svg}</div></div>`;

    app.innerHTML = `<div class="center">
      <div class="tabs">${tabButtons}<div class="spacer"></div>${gear}${savePng}</div>
      ${ui.popover && hasControls ? popoverHtml() : ""}
      ${body}
    </div>`;

    wire();
  }

  /* Plot-scoped controls, in a small popover under the ⚙ button — costs no
     standing width, so the chart keeps the whole editor at any split size. */
  function popoverHtml() {
    const sel = state.selected;
    let controls = "";
    if (ui.tab === "scatter") {
      const opts = (current, cols) => cols.map((c) => `<option value="${esc(c)}" ${c === current ? "selected" : ""}>${esc(c)}</option>`).join("");
      const cols = (state.preview && state.preview.columns) || [];
      controls = `
        <div class="field"><label>X axis</label><select id="scatter-x">${opts(ui.scatterX, cols)}</select></div>
        <div class="field"><label>Y axis</label><select id="scatter-y">${opts(ui.scatterY, cols)}</select></div>
        <div class="field"><label>Colour by</label><select id="colour-by">
          <option value="actual" ${ui.colourBy === "actual" ? "selected" : ""}>${esc(state.dataset.target ?? "target")}</option>
          <option value="predicted" ${ui.colourBy === "predicted" ? "selected" : ""} ${sel ? "" : "disabled"}>Predicted</option>
        </select></div>`;
    } else if (ui.tab === "pred") {
      controls = `
        <div class="control-row"><label>45° reference</label><button class="toggle ${ui.ref45 ? "on" : ""}" id="toggle-45"><span class="knob"></span></button></div>
        <div class="control-row"><label>Jitter overlapping points</label><button class="toggle ${ui.jitter ? "on" : ""}" id="toggle-jitter"><span class="knob"></span></button></div>`;
    }
    return `<div class="popover" id="popover"><div class="section-label">PLOT</div><div class="controls">${controls}</div></div>`;
  }

  function renderEmpty() {
    app.innerHTML = `<div class="empty"><div class="inner">
      <h1>Pick a dataset to start training.</h1>
      <p>Models run in a local Python environment, so anything installed there is available. Nothing leaves your machine.</p>
      <div class="buttons">
        <button class="btn primary" id="choose-dataset">Choose dataset</button>
        <button class="btn outline" id="load-sample">Load a sample</button>
      </div>
    </div></div>`;
    const choose = document.getElementById("choose-dataset");
    const sample = document.getElementById("load-sample");
    if (choose) choose.onclick = () => vscode.postMessage({ cmd: "chooseDataset" });
    if (sample) sample.onclick = () => vscode.postMessage({ cmd: "loadSample" });
  }

  function renderBanner() {
    const rt = state.runtime || {};
    if (rt.state === "starting") {
      banner.hidden = false;
      banner.className = "banner";
      banner.textContent = rt.message || "Starting local Python…";
    } else if (rt.state === "failed") {
      banner.hidden = false;
      banner.className = "banner error";
      banner.textContent = rt.message || "The Python runtime failed to start.";
    } else {
      banner.hidden = true;
    }
  }

  function wire() {
    for (const b of app.querySelectorAll(".tab")) {
      b.onclick = () => { ui.tab = b.dataset.tab; render(); };
    }
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on("gear", () => { ui.popover = !ui.popover; render(); });
    on("toggle-45", () => { ui.ref45 = !ui.ref45; render(); });
    on("toggle-jitter", () => { ui.jitter = !ui.jitter; render(); });
    on("save-png", savePng);
    const sx = document.getElementById("scatter-x");
    if (sx) sx.onchange = () => { ui.scatterX = sx.value; render(); };
    const sy = document.getElementById("scatter-y");
    if (sy) sy.onchange = () => { ui.scatterY = sy.value; render(); };
    const cb = document.getElementById("colour-by");
    if (cb) cb.onchange = () => { ui.colourBy = cb.value; render(); };
    for (const row of app.querySelectorAll(".compare tbody tr")) {
      row.onclick = () => vscode.postMessage({ cmd: "selectRun", key: row.dataset.key });
    }
  }

  function savePng() {
    const holder = document.getElementById("plot-canvas");
    const svg = holder && holder.querySelector("svg");
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = W * scale;
      canvas.height = H * scale;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = P.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      vscode.postMessage({
        cmd: "savePng",
        b64: canvas.toDataURL("image/png"),
        filename: `${(state.selected && state.selected.key) || "plot"}-${ui.tab}.png`,
      });
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
  }
})();
