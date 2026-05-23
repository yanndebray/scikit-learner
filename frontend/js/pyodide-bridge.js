/**
 * pyodide-bridge.js
 *
 * Boots Pyodide, installs scikit-learn / pandas / numpy / scipy / joblib,
 * loads /py/learner.py, then exposes window.pyCall() to the rest of the app.
 *
 * The bridge is intentionally tiny — every former HTTP endpoint becomes
 *
 *     await pyCall("fn_name", [arg1, arg2, ...])
 *
 * Returns plain JS objects (Python dicts → Object.fromEntries) or bytes
 * (Uint8Array) for download endpoints.
 */

(() => {
  const PYODIDE_VERSION = "0.28.0";
  const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  const PACKAGES = ["scikit-learn", "pandas", "numpy", "scipy", "joblib"];
  const PY_FILES = ["py/learner.py"];
  const DATA_FILES = ["data/airfoil.csv"];

  const state = {
    pyodide: null,
    learnerModule: null,
    ready: false,
    readyPromise: null,
  };

  // Loading-overlay helpers — overlay markup lives in index.html.
  function setProgress(label, pct) {
    const el = document.getElementById("pyodide-progress-label");
    const bar = document.getElementById("pyodide-progress-bar");
    if (el) el.textContent = label;
    if (bar && pct != null) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  function hideOverlay() {
    const o = document.getElementById("pyodide-overlay");
    if (o) o.style.display = "none";
  }
  function fail(message) {
    const el = document.getElementById("pyodide-progress-label");
    if (el) {
      el.textContent = `❌ ${message}`;
      el.style.color = "#b91c1c";
    }
    console.error("[pyodide-bridge]", message);
  }

  async function loadPyodideScript() {
    if (window.loadPyodide) return;
    setProgress("Loading Pyodide runtime…", 5);
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${PYODIDE_BASE}pyodide.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load pyodide.js from CDN"));
      document.head.appendChild(s);
    });
  }

  async function fetchText(path) {
    const r = await fetch(path, { cache: "force-cache" });
    if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
    return await r.text();
  }
  async function fetchBytes(path) {
    const r = await fetch(path, { cache: "force-cache" });
    if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async function bootstrap() {
    try {
      await loadPyodideScript();
      setProgress("Initializing Python runtime…", 15);
      state.pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

      setProgress("Loading scientific Python packages (one-time, ~15 MB)…", 30);
      await state.pyodide.loadPackage(PACKAGES, {
        messageCallback: (msg) => {
          if (/Loading\s+/.test(msg)) setProgress(`Loading: ${msg.replace(/^Loading\s+/, "")}`, null);
        },
      });

      setProgress("Vendoring sample data…", 75);
      for (const path of DATA_FILES) {
        const bytes = await fetchBytes(path);
        // Write at filesystem root so learner.py can read `/data/airfoil.csv` directly.
        const fsPath = `/${path}`;
        try { state.pyodide.FS.mkdirTree(fsPath.substring(0, fsPath.lastIndexOf("/"))); } catch {}
        state.pyodide.FS.writeFile(fsPath, bytes);
      }

      setProgress("Loading learner module…", 85);
      for (const path of PY_FILES) {
        const src = await fetchText(path);
        await state.pyodide.runPythonAsync(src);
      }

      // Sanity probe
      const ok = state.pyodide.runPython("_ready()");
      if (ok !== "ok") throw new Error(`learner module did not initialize cleanly: ${ok}`);

      setProgress("Ready", 100);
      state.ready = true;
      hideOverlay();
      window.dispatchEvent(new Event("pyodide-ready"));
    } catch (err) {
      fail(err.message || String(err));
      throw err;
    }
  }

  function toJsDeep(value) {
    // Convert PyProxy returns into JS-native shapes; numpy / dicts handled via dict_converter.
    if (value && typeof value.toJs === "function") {
      const js = value.toJs({ dict_converter: Object.fromEntries, create_proxies: false });
      value.destroy();
      return js;
    }
    return value;
  }

  function pyRepr(arg) {
    // Python literal for primitive args.
    if (arg === null || arg === undefined) return "None";
    if (typeof arg === "string") return JSON.stringify(arg);
    if (typeof arg === "number" || typeof arg === "boolean") return JSON.stringify(arg);
    if (arg instanceof Uint8Array) {
      // Passed via the globals shim — caller uses `args.push(buf)` and a placeholder.
      throw new Error("Use pyCallBinary() for Uint8Array arguments.");
    }
    return JSON.stringify(arg);
  }

  /**
   * Call a top-level Python function with JSON-able args. Returns a JS value.
   */
  async function pyCall(fn, args = []) {
    if (!state.ready) {
      await state.readyPromise;
    }
    const pyArgs = args.map(pyRepr).join(", ");
    const expr = `${fn}(${pyArgs})`;
    try {
      const result = state.pyodide.runPython(expr);
      return toJsDeep(result);
    } catch (err) {
      throw new Error(`pyCall ${fn}: ${err.message || err}`);
    }
  }

  /**
   * Call a function passing a binary buffer (Uint8Array) as the first arg + arbitrary
   * extra primitive args. Used for upload_csv(bytes, filename).
   */
  async function pyCallBinary(fn, buffer, extraArgs = []) {
    if (!state.ready) await state.readyPromise;
    // Expose the buffer to Python via globals.
    state.pyodide.globals.set("__bridge_buf", buffer);
    const pyArgs = extraArgs.map(pyRepr).join(", ");
    const expr = `${fn}(__bridge_buf${pyArgs ? ", " + pyArgs : ""})`;
    try {
      const result = state.pyodide.runPython(expr);
      const js = toJsDeep(result);
      return js;
    } catch (err) {
      throw new Error(`pyCallBinary ${fn}: ${err.message || err}`);
    } finally {
      state.pyodide.globals.delete("__bridge_buf");
    }
  }

  /**
   * Trigger a browser download from a bytes payload.
   */
  function downloadBytes(bytes, filename, mimeType = "application/octet-stream") {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Expose
  window.pyCall = pyCall;
  window.pyCallBinary = pyCallBinary;
  window.downloadBytes = downloadBytes;
  window.pyodideReady = () => state.ready;

  state.readyPromise = bootstrap();
})();
