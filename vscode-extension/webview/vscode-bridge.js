/**
 * vscode-bridge.js
 *
 * Drop-in replacement for the web app's pyodide-bridge.js inside a VS Code
 * webview. Same surface — pyCall(), pyCallBinary(), downloadBytes(),
 * pyodideReady() and the "pyodide-ready" event — but instead of running
 * Python in WASM, every call is posted to the extension host, which forwards
 * it to a local Python process running the very same learner.py.
 *
 * app.js is loaded unmodified; it cannot tell the difference.
 */

(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    ready: false,
    nextId: 1,
    pending: new Map(), // id -> {resolve, reject}
  };

  /* ---- loading overlay (markup lives in index.html) ----------------- */
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
  function showOverlayError(message) {
    const o = document.getElementById("pyodide-overlay");
    if (o) o.style.display = "flex";
    const el = document.getElementById("pyodide-progress-label");
    if (el) {
      el.textContent = `❌ ${message}`;
      el.style.color = "#b91c1c";
    }
  }

  /* ---- base64 helpers (payloads can be megabytes; chunk the codec) --- */
  function toB64(u8) {
    let out = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }
  function fromB64(b64) {
    const raw = atob(b64);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    return u8;
  }

  /* ---- the call path ------------------------------------------------- */
  function post(fn, args, bufB64) {
    const id = state.nextId++;
    const message = { type: "py", id, fn, args };
    if (bufB64 !== undefined) message.buf = bufB64;
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      vscode.postMessage(message);
    });
  }

  async function pyCall(fn, args = []) {
    try {
      return await post(fn, args);
    } catch (err) {
      throw new Error(`pyCall ${fn}: ${err.message || err}`);
    }
  }

  async function pyCallBinary(fn, buffer, extraArgs = []) {
    try {
      return await post(fn, extraArgs, toB64(buffer));
    } catch (err) {
      throw new Error(`pyCallBinary ${fn}: ${err.message || err}`);
    }
  }

  /** In a browser this creates an <a download>; in a webview downloads are
   *  the host's job — the extension shows a save dialog and writes the file. */
  function downloadBytes(bytes, filename, mimeType = "application/octet-stream") {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    vscode.postMessage({ type: "save", filename, mime: mimeType, b64: toB64(u8) });
  }

  /* ---- messages from the extension host ------------------------------ */
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "py-result") {
      const pending = state.pending.get(msg.id);
      if (!pending) return;
      state.pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.bin !== undefined ? fromB64(msg.bin) : msg.result);
      } else {
        pending.reject(new Error(msg.error || "unknown error"));
      }
      return;
    }

    if (msg.type === "status") {
      if (msg.state === "starting") {
        setProgress(msg.message || "Starting local Python…", msg.pct ?? null);
      } else if (msg.state === "ready") {
        setProgress("Ready", 100);
        hideOverlay();
        if (!state.ready) {
          state.ready = true;
          window.dispatchEvent(new Event("pyodide-ready"));
        }
      } else if (msg.state === "failed") {
        showOverlayError(msg.message || "The Python runtime failed to start.");
      }
    }
  });

  /* alert() is a no-op inside webviews; app.js uses it for validation and
     error messages. Route those to a proper VS Code notification. */
  window.alert = (message) => vscode.postMessage({ type: "alert", message: String(message) });

  // Expose the exact surface app.js expects.
  window.pyCall = pyCall;
  window.pyCallBinary = pyCallBinary;
  window.downloadBytes = downloadBytes;
  window.pyodideReady = () => state.ready;

  // Tell the host we exist; it answers with the current runtime status.
  vscode.postMessage({ type: "init" });
})();
