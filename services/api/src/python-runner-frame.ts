import { createHash } from 'node:crypto';

/**
 * Browser practice runs of Python (audit N02). The learner page loads this document in an iframe
 * with sandbox="allow-scripts" (never allow-same-origin), and the document's own CSP repeats
 * `sandbox allow-scripts`, so it has an opaque origin even when opened directly: no cookies, no
 * storage of Core's origin, no access to the parent's DOM. The frame starts one dedicated Worker
 * from a blob: URL; that worker runs Pyodide and the learner's code. Workers created from blob:
 * URLs inherit this document's policy, so connect-src 'none' covers the worker too, and the worker
 * also replaces fetch and removes XMLHttpRequest, WebSocket, EventSource and the rest before any
 * learner code runs.
 *
 * Nothing in the frame can reach the network or Core's API. The parent fetches the pinned Pyodide
 * files from Core's own origin, checks every SHA-256 and hands the bytes over the private
 * MessagePort. A run's result goes back over the same port and is shown to the learner only:
 * browser runs are practice and never become evidence (grading stays with the server sandbox).
 *
 * The scripts below are plain JavaScript text (not compiled TypeScript) so the bytes the browser
 * runs, the bytes the CSP hash names and the bytes the unit tests execute are the same.
 */

/** Wall-clock watchdog and output budget, shared by the frame and the unit tests. */
export const RUNNER_LIMITS_SOURCE = String.raw`
function createRunWatchdog(timeoutMs, onExpire, timers) {
  var handle = null, expired = false;
  return {
    start: function () {
      if (handle !== null) timers.clear(handle);
      expired = false;
      handle = timers.set(function () { handle = null; expired = true; onExpire(); }, timeoutMs);
    },
    finish: function () {
      if (handle !== null) { timers.clear(handle); handle = null; }
      return !expired;
    },
    active: function () { return handle !== null; }
  };
}
function createOutputBudget(limitBytes) {
  var used = 0, exceeded = false, encoder = new TextEncoder();
  return {
    take: function (text) {
      if (exceeded) return { text: "", exceeded: true };
      // A character is at least one UTF-8 byte: anything past limitBytes + 1 characters cannot fit.
      if (text.length > limitBytes + 1) text = text.slice(0, limitBytes + 1);
      var size = encoder.encode(text).length;
      if (used + size <= limitBytes) { used += size; return { text: text, exceeded: false }; }
      var room = limitBytes - used, kept = "", keptSize = 0;
      for (var character of text) {
        var length = encoder.encode(character).length;
        if (keptSize + length > room) break;
        kept += character; keptSize += length;
      }
      used += keptSize; exceeded = true;
      return { text: kept, exceeded: true };
    },
    used: function () { return used; },
    exceeded: function () { return exceeded; }
  };
}
function boundedInteger(value, minimum, maximum, fallback) {
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
`;

/** Runs inside the dedicated worker. Learner code runs here and nowhere else. */
export const RUNNER_WORKER_SOURCE = String.raw`(function () {
  "use strict";
  var BASE = "https://pyodide.invalid/", PAGE = 65536, FILE = "<your code>";
  var post = self.postMessage.bind(self), Memory = WebAssembly.Memory, grow = Memory.prototype.grow;
  var bufferOf = Object.getOwnPropertyDescriptor(Memory.prototype, "buffer").get, Resp = Response, Req = Request;
  var realImportScripts = self.importScripts.bind(self);
  var files = null, pyodide = null, runner = null, memoryCap = 268435456;
  // Memory guard: Pyodide grows its heap from JavaScript (Memory.prototype.grow). Past the cap the
  // growth fails, malloc returns NULL and Python raises MemoryError instead of exhausting the tab.
  Object.defineProperty(Memory.prototype, "grow", { value: function (delta) {
    var current = Reflect.apply(bufferOf, this, []).byteLength;
    if (current + Number(delta) * PAGE > memoryCap) throw new RangeError("Practice runs are limited in memory.");
    return Reflect.apply(grow, this, [delta]);
  }, writable: false, configurable: false });
  // The only "network" is the pinned files the parent verified. Every other URL is refused here,
  // and connect-src 'none' refuses it again.
  function localFetch(input) {
    var url = input instanceof Req ? input.url : String(input);
    var name = url.indexOf(BASE) === 0 ? url.slice(BASE.length) : "";
    if (!files || !Object.prototype.hasOwnProperty.call(files, name)) return Promise.reject(new TypeError("Network access is disabled in practice runs."));
    return Promise.resolve(new Resp(files[name], { headers: { "Content-Type": /\.wasm$/.test(name) ? "application/wasm" : "application/octet-stream" } }));
  }
  Object.defineProperty(self, "fetch", { value: localFetch, writable: false, configurable: false });
  // Pyodide probes for a classic worker with importScripts("data:..."), which the CSP refuses
  // noisily; answer that probe here instead.
  self.importScripts = function (url) {
    if (typeof url === "string" && url.indexOf("data:") === 0) throw new TypeError("Refused.");
    return realImportScripts.apply(null, arguments);
  };
  var NETWORK = ["XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport", "importScripts", "Worker", "SharedWorker",
    "indexedDB", "caches", "BroadcastChannel", "RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  function closeNetwork() {
    for (var i = 0; i < NETWORK.length; i++) {
      var name = NETWORK[i];
      try { delete self[name]; } catch (e) {}
      try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
    }
  }
  function streamWriter(stream) {
    var decoder = new TextDecoder("utf-8");
    return { write: function (bytes) { var text = decoder.decode(bytes, { stream: true }); if (text) post({ type: "output", stream: stream, text: text }); return bytes.length; } };
  }
  var HELPER = [
    "import json, linecache, sys, traceback",
    "def _course_practice_run(source, sample, file):",
    "    linecache.cache[file] = (len(source), None, source.splitlines(True), file)",
    "    def report(error):",
    "        tb = error.__traceback__",
    "        while tb is not None and tb.tb_frame.f_code.co_filename != file:",
    "            tb = tb.tb_next",
    "        sys.stderr.write(''.join(traceback.format_exception(type(error), error, tb)))",
    "    namespace = {'__name__': '__main__', '__builtins__': __builtins__}",
    "    try:",
    "        exec(compile(source, file, 'exec'), namespace)",
    "        if sample is not None:",
    "            solve = namespace.get('solve')",
    "            if not callable(solve):",
    "                sys.stderr.write('Your code does not define solve(input), so the sample input was not used.\\n')",
    "                return 'error'",
    "            result = solve(json.loads(sample))",
    "            print('solve(sample input) returned:', repr(result))",
    "        return 'ok'",
    "    except MemoryError as error:",
    "        report(error)",
    "        return 'memory_limit'",
    "    except SystemExit:",
    "        return 'ok'",
    "    except BaseException as error:",
    "        report(error)",
    "        return 'error'",
    "    finally:",
    "        sys.stdout.flush()",
    "        sys.stderr.flush()"
  ].join("\n");
  async function load(message) {
    files = message.files;
    if (typeof message.memoryBytes === "number" && message.memoryBytes > 0) memoryCap = message.memoryBytes;
    var blobUrl = function (bytes) { return URL.createObjectURL(new Blob([bytes], { type: "text/javascript" })); };
    realImportScripts(blobUrl(files["pyodide.js"]));
    var createPyodideModule = (await import(blobUrl(files["pyodide.asm.mjs"]))).default;
    var lockFileContents = JSON.parse(new TextDecoder().decode(files["pyodide-lock.json"]));
    pyodide = await self.loadPyodide({ indexURL: BASE, packageBaseUrl: BASE, createPyodideModule: createPyodideModule, lockFileContents: lockFileContents,
      stdin: function () { return null; }, env: { HOME: "/home/pyodide" } });
    pyodide.setStdout(streamWriter("stdout"));
    pyodide.setStderr(streamWriter("stderr"));
    pyodide.runPython(HELPER);
    runner = pyodide.globals.get("_course_practice_run");
    files = null;
    closeNetwork();
    try { delete self.loadPyodide; } catch (e) {}
    post({ type: "loaded", version: String(pyodide.version) });
  }
  self.onmessage = function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "init" && !pyodide && !files) {
      load(message).catch(function (error) { post({ type: "load_failed", reason: String(error && error.message || error).slice(0, 300) }); });
      return;
    }
    if (message.type === "run" && runner) {
      var status;
      // No sample input is undefined, not null: Pyodide maps JavaScript null to jsnull, not None.
      try { status = runner(String(message.code), typeof message.input === "string" ? message.input : undefined, FILE); }
      catch (error) {
        // A JavaScript-level failure (for example a fatal interpreter error): this interpreter is done.
        post({ type: "output", stream: "stderr", text: "The Python runtime stopped unexpectedly. Run again to start a fresh one.\n" });
        post({ type: "done", status: "crashed" });
        return;
      }
      post({ type: "done", status: status === "error" || status === "memory_limit" ? status : "ok" });
    }
  };
})();`;

/** Runs in the sandboxed frame: hands the verified files to a fresh worker, enforces the watchdog
 * and output budget on whatever the worker says, and terminates the worker when a limit is hit. */
export const RUNNER_FRAME_SOURCE = String.raw`(function (WORKER_SOURCE) {
  "use strict";
  var parentWindow = window.parent;
  var match = /^#([A-Za-z0-9_-]{16,64})$/.exec(location.hash), nonce = match ? match[1] : null;
  var FILES = ["pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  var MAX_FILE_BYTES = 33554432, MAX_SOURCE_CHARS = 262144, MAX_INPUT_CHARS = 65536, FLUSH_MS = 50;
  var timers = { set: function (callback, ms) { return setTimeout(callback, ms); }, clear: function (handle) { clearTimeout(handle); } };
  var port = null, files = null, memoryBytes = 268435456, worker = null, workerUrl = null, state = "empty", run = null;
  function send(message) { if (port) port.postMessage(message); }
  function discardWorker() {
    if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null; }
    state = "empty";
  }
  function flush() {
    if (!run || !run.pending.length) return;
    for (var i = 0; i < run.pending.length; i++) send({ type: "output", id: run.id, stream: run.pending[i].stream, text: run.pending[i].text });
    run.pending = [];
  }
  function append(stream, text) {
    var last = run.pending[run.pending.length - 1];
    if (last && last.stream === stream) last.text += text; else run.pending.push({ stream: stream, text: text });
  }
  function finish(status) {
    if (!run) return;
    var current = run;
    current.watchdog.finish();
    clearInterval(current.flushTimer);
    flush();
    run = null;
    // A run that hit a limit, was stopped or crashed leaves no worker behind; the next run starts a fresh one.
    if (status === "ok" || status === "error" || status === "memory_limit") { if (status === "memory_limit") discardWorker(); else state = "ready"; }
    else discardWorker();
    send({ type: "done", id: current.id, status: status, durationMs: current.started ? Math.round(performance.now() - current.started) : 0, outputBytes: current.budget.used() });
  }
  function dispatch() {
    run.started = performance.now();
    state = "running";
    run.watchdog.start();
    send({ type: "started", id: run.id });
    worker.postMessage({ type: "run", code: run.code, input: run.input });
  }
  function onWorkerMessage(event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (state === "loading") {
      if (data.type === "loaded") {
        state = "ready";
        send({ type: "loaded", version: String(data.version).slice(0, 40) });
        if (run) dispatch();
      } else if (data.type === "load_failed") failLoad(typeof data.reason === "string" ? data.reason : "");
      return;
    }
    if (!run || state !== "running") return;
    if (data.type === "output" && typeof data.text === "string") {
      var taken = run.budget.take(data.text);
      if (taken.text) append(data.stream === "stderr" ? "stderr" : "stdout", taken.text);
      if (taken.exceeded) finish("output_limit");
    } else if (data.type === "done") {
      finish(data.status === "error" || data.status === "memory_limit" || data.status === "crashed" ? data.status : "ok");
    }
  }
  function failLoad(reason) {
    discardWorker();
    send({ type: "load_failed", reason: reason.slice(0, 300) });
    if (run) finish("unavailable");
  }
  function startWorker() {
    state = "loading";
    send({ type: "loading" });
    workerUrl = workerUrl || URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    try { worker = new Worker(workerUrl, { name: "python-practice" }); }
    catch (error) { failLoad("worker"); return; }
    worker.onmessage = onWorkerMessage;
    worker.onmessageerror = function () {};
    worker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      if (state === "loading") failLoad("worker");
      else if (run) finish("crashed");
      else discardWorker();
    };
    // A copy: the frame keeps the files to start a fresh worker after a limit or a stop.
    worker.postMessage({ type: "init", files: files, memoryBytes: memoryBytes });
  }
  function onLoad(data) {
    if (files || !data.files || typeof data.files !== "object") return;
    var accepted = {};
    for (var i = 0; i < FILES.length; i++) {
      var bytes = data.files[FILES[i]];
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) { send({ type: "load_failed", reason: "files" }); return; }
      accepted[FILES[i]] = bytes;
    }
    files = accepted;
    memoryBytes = boundedInteger(data.memoryBytes, 67108864, 1073741824, memoryBytes);
    startWorker();
  }
  function onRun(data) {
    var id = data.id;
    if (!Number.isSafeInteger(id) || id < 1) return;
    if (run) { send({ type: "done", id: id, status: "busy", durationMs: 0, outputBytes: 0 }); return; }
    if (typeof data.code !== "string" || data.code.length > MAX_SOURCE_CHARS || (data.input !== null && (typeof data.input !== "string" || data.input.length > MAX_INPUT_CHARS))) {
      send({ type: "done", id: id, status: "invalid", durationMs: 0, outputBytes: 0 }); return;
    }
    var timeoutMs = boundedInteger(data.timeoutMs, 100, 60000, 10000), outputBytes = boundedInteger(data.outputBytes, 256, 1048576, 65536);
    run = { id: id, code: data.code, input: data.input, started: 0, pending: [], budget: createOutputBudget(outputBytes),
      watchdog: createRunWatchdog(timeoutMs, function () { finish("timeout"); }, timers), flushTimer: setInterval(flush, FLUSH_MS) };
    if (state === "ready") dispatch();
    else if (state === "empty") { if (files) startWorker(); else finish("unavailable"); }
  }
  window.addEventListener("message", function (event) {
    if (port || !nonce || event.source !== parentWindow || !event.ports || event.ports.length !== 1) return;
    var data = event.data;
    if (!data || data.type !== "python-runner-init" || data.nonce !== nonce) return;
    port = event.ports[0];
    port.onmessage = function (message) {
      var command = message.data;
      if (!command || typeof command !== "object") return;
      if (command.type === "load") onLoad(command);
      else if (command.type === "run") onRun(command);
      else if (command.type === "stop" && run && run.id === command.id) finish("stopped");
    };
    send({ type: "ready" });
  });
  if (nonce) parentWindow.postMessage({ type: "python-runner-hello", nonce: nonce }, "*");
})`;

/** The one inline script of the frame document. */
export const RUNNER_FRAME_SCRIPT = `${RUNNER_LIMITS_SOURCE}\n${RUNNER_FRAME_SOURCE}(${JSON.stringify(RUNNER_WORKER_SOURCE).replace(/</g, '\\u003c')});\n`;
const scriptHash = (script: string) => `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;

/**
 * Only the frame's own script runs in the document; blob: lets it start the worker and lets the
 * worker evaluate the verified Pyodide files it was handed (blob: URLs of this opaque origin only),
 * and 'wasm-unsafe-eval' lets it compile WebAssembly. No fetch/XHR/WebSocket/beacon (connect-src),
 * no subresources, styles, nested frames, forms or plugins.
 */
export function runnerFrameContentSecurityPolicy() {
  return [`default-src 'none'`, `script-src ${scriptHash(RUNNER_FRAME_SCRIPT)} blob: 'wasm-unsafe-eval'`, `worker-src blob:`, `connect-src 'none'`,
    `style-src 'none'`, `img-src 'none'`, `font-src 'none'`, `media-src 'none'`, `frame-src 'none'`, `child-src 'none'`, `manifest-src 'none'`,
    `object-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`, `sandbox allow-scripts`].join('; ');
}
export function runnerFrameDocument() {
  if (/<\/script|<!--/i.test(RUNNER_FRAME_SCRIPT)) throw new Error('Runner frame script cannot be inlined.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Python practice runner</title></head><body><script>${RUNNER_FRAME_SCRIPT}</script></body></html>`;
}
