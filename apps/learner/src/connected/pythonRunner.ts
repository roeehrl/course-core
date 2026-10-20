/**
 * The parent half of browser practice runs (audit N02). Core serves a runner document that the
 * learner page loads in an iframe with sandbox="allow-scripts": an opaque origin with no cookies,
 * no storage of this origin, no access to this page and a CSP with connect-src 'none'. The frame
 * runs Pyodide and the learner's code in a dedicated worker it terminates at its own watchdog.
 *
 * This module fetches the pinned Pyodide files from Core's own origin, refuses any whose SHA-256
 * differs from the pins compiled into this app, hands the bytes to the frame over a private
 * MessagePort and keeps an outer watchdog: a frame that stops answering is removed, which ends
 * its worker too. A run sends nothing to the server. It is practice only and never evidence.
 */

import { sha256HexOfBytes } from "../client/webCrypto";

/** Pinned with services/api/src/python-runner.ts (a root infrastructure test compares them). */
export const PINNED_PYODIDE = Object.freeze({
  version: "314.0.7",
  files: Object.freeze({
    "pyodide.js": { sha256: "3141b814715a72e59b51b1b18b9ceae5bf19f7c852417e431bb0a34feadf825c", size: 18_912 },
    "pyodide.asm.mjs": { sha256: "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635", size: 1_250_344 },
    "pyodide.asm.wasm": { sha256: "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6", size: 9_598_218 },
    "python_stdlib.zip": { sha256: "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a", size: 2_545_637 },
    "pyodide-lock.json": { sha256: "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010", size: 119_077 },
  } as Record<string, { sha256: string; size: number }>),
});
/** Sandbox of the runner frame: scripts only, never allow-same-origin. */
export const RUNNER_FRAME_SANDBOX = "allow-scripts";
export const RUNNER_CONFIG_PATH = "/api/python-runner";
/** Outer watchdog: time for the frame to say hello, to load Python, and grace after the frame's own limit. */
export const HANDSHAKE_TIMEOUT_MS = 15_000;
export const LOAD_TIMEOUT_MS = 90_000;
export const RUN_GRACE_MS = 2_000;
export const STOP_GRACE_MS = 1_000;

export interface RunnerLimits { timeoutMs: number; outputBytes: number; memoryBytes: number; sourceBytes: number }
export interface RunnerConfig {
  status: "ready";
  frameUrl: string;
  assets: { name: string; sha256: string; size: number; url: string }[];
  limits: RunnerLimits;
  runtime: { name: string; version: string; license: { spdx: string; source: string } };
}
export type RunStatus = "ok" | "error" | "timeout" | "output_limit" | "memory_limit" | "stopped" | "crashed" | "unavailable" | "busy" | "invalid";
export interface RunResult { status: RunStatus; durationMs: number; outputBytes: number; reason?: string }
export type OutputStream = "stdout" | "stderr";
export interface RunCallbacks { onOutput(stream: OutputStream, text: string): void; onPhase?(phase: "loading" | "running"): void }

const RUN_STATUSES = new Set<RunStatus>(["ok", "error", "timeout", "output_limit", "memory_limit", "stopped", "crashed", "unavailable", "busy", "invalid"]);
const SAFE_PATH = /^\/api\/python-runner\/[A-Za-z0-9._/-]{1,120}$/;

/** The server's runner description, accepted only when it names exactly the pinned files. */
export function acceptRunnerConfig(value: unknown): RunnerConfig | null {
  if (!value || typeof value !== "object") return null;
  const config = value as Partial<RunnerConfig> & { status?: unknown };
  if (config.status !== "ready" || typeof config.frameUrl !== "string" || !SAFE_PATH.test(config.frameUrl) || config.runtime?.version !== PINNED_PYODIDE.version) return null;
  const names = Object.keys(PINNED_PYODIDE.files);
  if (!Array.isArray(config.assets) || config.assets.length !== names.length) return null;
  for (const asset of config.assets) {
    const pin = PINNED_PYODIDE.files[asset?.name];
    if (!pin || asset.sha256 !== pin.sha256 || asset.size !== pin.size || typeof asset.url !== "string" || !SAFE_PATH.test(asset.url)) return null;
  }
  if (new Set(config.assets.map((asset) => asset.name)).size !== names.length) return null;
  const limits = config.limits;
  const positive = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (!limits || !positive(limits.timeoutMs) || !positive(limits.outputBytes) || !positive(limits.memoryBytes) || !positive(limits.sourceBytes)) return null;
  return config as RunnerConfig;
}

let configRequest: Promise<RunnerConfig | null> | null = null;
/** One request per page; any failure means "no practice runs here". */
export function loadRunnerConfig(fetchImpl: typeof fetch = fetch): Promise<RunnerConfig | null> {
  configRequest ??= fetchImpl(RUNNER_CONFIG_PATH, { credentials: "same-origin" })
    .then(async (response) => (response.ok ? acceptRunnerConfig(await response.json()) : null))
    .catch(() => null);
  return configRequest;
}

export interface RunnerDependencies {
  document: Document;
  fetch: typeof fetch;
  /** SHA-256 of the bytes as lowercase hex. */
  digest(bytes: ArrayBuffer): Promise<string>;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  randomNonce(): string;
}
export function browserDependencies(): RunnerDependencies | null {
  if (typeof window === "undefined" || typeof MessageChannel === "undefined" || typeof Worker === "undefined") return null;
  return {
    document: window.document,
    fetch: window.fetch.bind(window),
    // Web Crypto where the page has it; the same digest in plain JavaScript on a non-secure page.
    digest: (bytes) => sha256HexOfBytes(new Uint8Array(bytes)),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle),
    randomNonce: () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join(""),
  };
}

/** Fetches every pinned file and checks size and SHA-256 against the pins in this bundle. */
export async function fetchVerifiedFiles(config: RunnerConfig, deps: Pick<RunnerDependencies, "fetch" | "digest">) {
  const entries = await Promise.all(config.assets.map(async (asset) => {
    const pin = PINNED_PYODIDE.files[asset.name]!;
    const response = await deps.fetch(asset.url, { credentials: "omit" });
    if (!response.ok) throw new Error("asset_unavailable");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== pin.size || (await deps.digest(bytes)) !== pin.sha256) throw new Error("asset_integrity");
    return [asset.name, bytes] as const;
  }));
  return Object.fromEntries(entries) as Record<string, ArrayBuffer>;
}

interface ActiveRun { id: number; callbacks: RunCallbacks; resolve(result: RunResult): void; timer: number | null; stopTimer: number | null; outputBytes: number }

/**
 * One runner per page (one Python worker at most, T02). Runs are sequential; a second run while
 * one is active answers "busy".
 */
export class PythonPracticeRunner {
  private frame: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private connecting: Promise<MessagePort> | null = null;
  private loaded = false;
  private active: ActiveRun | null = null;
  private sequence = 0;
  private disposeListeners: (() => void) | null = null;
  constructor(readonly config: RunnerConfig, private readonly deps: RunnerDependencies) {}

  get running() { return this.active !== null; }

  async run(code: string, input: string | null, callbacks: RunCallbacks): Promise<RunResult> {
    if (this.active) return { status: "busy", durationMs: 0, outputBytes: 0 };
    const id = ++this.sequence;
    const result = new Promise<RunResult>((resolve) => { this.active = { id, callbacks, resolve, timer: null, stopTimer: null, outputBytes: 0 }; });
    const active = this.active!;
    // Until the frame says the run started, it may be connecting or loading Python.
    this.arm(active, LOAD_TIMEOUT_MS, "unavailable");
    try {
      const port = await this.connect();
      if (this.active !== active) return result;
      if (!this.loaded) {
        callbacks.onPhase?.("loading");
        const files = await fetchVerifiedFiles(this.config, this.deps);
        if (this.active !== active) return result;
        port.postMessage({ type: "load", files, memoryBytes: this.config.limits.memoryBytes }, Object.values(files));
        this.loaded = true;
      }
      port.postMessage({ type: "run", id, code, input, timeoutMs: this.config.limits.timeoutMs, outputBytes: this.config.limits.outputBytes });
    } catch (error) {
      this.dispose();
      this.settle(active, { status: "unavailable", durationMs: 0, outputBytes: 0, reason: error instanceof Error ? error.message : "failed" });
    }
    return result;
  }

  /** Asks the frame to terminate the run; removes the frame if it does not answer in time. */
  stop() {
    const active = this.active;
    if (!active || active.stopTimer !== null) return;
    this.port?.postMessage({ type: "stop", id: active.id });
    active.stopTimer = this.deps.setTimeout(() => { if (this.active === active) { this.dispose(); this.settle(active, { status: "stopped", durationMs: 0, outputBytes: active.outputBytes }); } }, STOP_GRACE_MS);
  }

  /** Removes the frame (and with it any worker and interpreter state). The next run starts fresh. */
  reset() {
    const active = this.active;
    this.dispose();
    if (active) this.settle(active, { status: "stopped", durationMs: 0, outputBytes: active.outputBytes });
  }

  private arm(active: ActiveRun, ms: number, status: RunStatus) {
    if (active.timer !== null) this.deps.clearTimeout(active.timer);
    active.timer = this.deps.setTimeout(() => {
      if (this.active !== active) return;
      // The frame did not answer within its own limit plus grace: remove it, which ends its worker.
      this.dispose();
      this.settle(active, { status, durationMs: 0, outputBytes: active.outputBytes });
    }, ms);
  }

  private settle(active: ActiveRun, result: RunResult) {
    if (active.timer !== null) this.deps.clearTimeout(active.timer);
    if (active.stopTimer !== null) this.deps.clearTimeout(active.stopTimer);
    if (this.active === active) this.active = null;
    active.resolve(result);
  }

  private dispose() {
    this.disposeListeners?.();
    this.disposeListeners = null;
    this.port?.close();
    this.port = null;
    this.connecting = null;
    this.frame?.remove();
    this.frame = null;
    this.loaded = false;
  }

  private connect(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    if (this.connecting) return this.connecting;
    const { document } = this.deps, view = document.defaultView!;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", RUNNER_FRAME_SANDBOX);
    frame.setAttribute("title", "Python practice runner");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.className = "connected-python-runner-frame";
    frame.dataset.testid = "python-runner-frame";
    this.frame = frame;
    const nonce = this.deps.randomNonce();
    this.connecting = new Promise<MessagePort>((resolve, reject) => {
      let loads = 0, sent = false;
      const timer = this.deps.setTimeout(() => reject(new Error("frame_timeout")), HANDSHAKE_TIMEOUT_MS);
      const onHello = (event: MessageEvent) => {
        if (sent || loads > 1 || !frame.contentWindow || event.source !== frame.contentWindow) return;
        const data = event.data as { type?: unknown; nonce?: unknown } | null;
        if (!data || data.type !== "python-runner-hello" || data.nonce !== nonce) return;
        sent = true;
        const channel = new MessageChannel();
        const port = channel.port1;
        port.onmessage = (message) => {
          const value = message.data as { type?: unknown } | null;
          if (value?.type === "ready" && !this.port && this.frame === frame) { this.deps.clearTimeout(timer); this.port = port; resolve(port); return; }
          if (this.port === port) this.handle(value);
        };
        // An opaque origin: "*" is the only possible target. The message carries no secrets.
        frame.contentWindow.postMessage({ type: "python-runner-init", nonce }, "*", [channel.port2]);
      };
      const onLoad = () => {
        loads++;
        // The frame navigated away from Core's runner document: whatever is there gets nothing.
        if (loads > 1 && this.frame === frame) {
          const active = this.active;
          this.dispose();
          if (active) this.settle(active, { status: "crashed", durationMs: 0, outputBytes: active.outputBytes });
        }
      };
      view.addEventListener("message", onHello);
      frame.addEventListener("load", onLoad);
      this.disposeListeners = () => { view.removeEventListener("message", onHello); frame.removeEventListener("load", onLoad); this.deps.clearTimeout(timer); reject(new Error("disposed")); };
    });
    frame.src = `${this.config.frameUrl}#${nonce}`;
    document.body.appendChild(frame);
    return this.connecting;
  }

  /** Everything from the frame is untrusted data: only known shapes for the current run count. */
  private handle(value: unknown) {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>, active = this.active;
    if (message.type === "load_failed") {
      this.dispose();
      if (active) this.settle(active, { status: "unavailable", durationMs: 0, outputBytes: active.outputBytes, reason: "load_failed" });
      return;
    }
    if (message.type === "loading") { active?.callbacks.onPhase?.("loading"); return; }
    if (!active || message.id !== active.id) return;
    if (message.type === "started") {
      active.callbacks.onPhase?.("running");
      this.arm(active, this.config.limits.timeoutMs + RUN_GRACE_MS, "timeout");
    } else if (message.type === "output" && typeof message.text === "string") {
      // The frame enforces the budget; this is the same bound again, so a broken frame cannot flood the page.
      const room = this.config.limits.outputBytes - active.outputBytes;
      if (room <= 0) return;
      const text = message.text.slice(0, room);
      active.outputBytes += new TextEncoder().encode(text).length;
      active.callbacks.onOutput(message.stream === "stderr" ? "stderr" : "stdout", text);
    } else if (message.type === "done") {
      const status = RUN_STATUSES.has(message.status as RunStatus) ? (message.status as RunStatus) : "crashed";
      const durationMs = typeof message.durationMs === "number" && Number.isFinite(message.durationMs) ? Math.max(0, Math.round(message.durationMs)) : 0;
      this.settle(active, { status, durationMs, outputBytes: active.outputBytes });
    }
  }
}

let shared: PythonPracticeRunner | null = null;
/** The page's runner, or null when this server or browser cannot offer practice runs. */
export async function practiceRunner(): Promise<PythonPracticeRunner | null> {
  const config = await loadRunnerConfig(), deps = browserDependencies();
  if (!config || !deps) return null;
  shared ??= new PythonPracticeRunner(config, deps);
  return shared;
}
