import React from "react";
import { createHash, webcrypto } from "node:crypto";
import { MessageChannel as NodeMessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HANDSHAKE_TIMEOUT_MS,
  LOAD_TIMEOUT_MS,
  PINNED_PYODIDE,
  PythonPracticeRunner,
  RUN_GRACE_MS,
  STOP_GRACE_MS,
  acceptRunnerConfig,
  fetchVerifiedFiles,
  type RunnerConfig,
  type RunnerDependencies,
  type RunResult,
} from "../src/connected/pythonRunner";
import { sha256HexOfBytes } from "../src/client/webCrypto";
import { PracticeRunner, resultMessage, type PracticeRunnerHandle } from "../src/components/PracticeRunner.web";
import { pressWhenReady } from "./pressWhenReady";

// Shared by every test, so frozen: a test changes only the fresh copy config() hands it.
const limits = Object.freeze({ timeoutMs: 5000, outputBytes: 64, memoryBytes: 256 * 1024 * 1024, sourceBytes: 64_000 });
function config(): RunnerConfig {
  return {
    status: "ready",
    frameUrl: "/api/python-runner/frame",
    assets: Object.entries(PINNED_PYODIDE.files).map(([name, pin]) => ({ name, ...pin, url: `/api/python-runner/assets/314.0.7/${name}` })),
    limits: { ...limits },
    runtime: { name: "pyodide", version: "314.0.7", license: { spdx: "MPL-2.0", source: "https://github.com/pyodide/pyodide/tree/314.0.7" } },
  };
}
const pinBySize = (size: number) => Object.values(PINNED_PYODIDE.files).find((pin) => pin.size === size)?.sha256 ?? "0".repeat(64);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** Manual timers (the runner's watchdog), a fetch of correctly sized bytes and a scripted frame on a real MessageChannel. */
function harness(options: { digest?: (bytes: ArrayBuffer) => Promise<string>; answer?: boolean } = {}) {
  let now = 0, next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => new Response(new ArrayBuffer(PINNED_PYODIDE.files[url.split("/").pop()!]!.size)));
  const deps: RunnerDependencies = {
    document,
    fetch: fetch as unknown as typeof globalThis.fetch,
    digest: options.digest ?? (async (bytes) => pinBySize(bytes.byteLength)),
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    randomNonce: () => "N".repeat(24),
  };
  const received: Record<string, unknown>[] = [];
  let port: NodeMessagePort | null = null;
  const frame = () => document.querySelector<HTMLIFrameElement>('iframe[data-testid="python-runner-frame"]');
  /** Plays the frame's half of the handshake (hello, then "ready" on the port it is handed). */
  async function hello() {
    const element = frame()!;
    vi.spyOn(element.contentWindow!, "postMessage").mockImplementation(((_message: unknown, _origin: string, transfer: NodeMessagePort[]) => {
      port = transfer[0]!;
      port.on("message", (data: Record<string, unknown>) => received.push(data));
      if (options.answer !== false) port.postMessage({ type: "ready" });
    }) as never);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "python-runner-hello", nonce: "N".repeat(24) }, source: element.contentWindow }));
    await settle();
  }
  return {
    deps, fetch, received, frame, hello,
    send: async (message: unknown) => { port!.postMessage(message); await settle(); },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await settle();
    },
  };
}
const webCrypto = globalThis.crypto ?? webcrypto;
// Node's MessageChannel stands in for the browser's (jsdom has none) so ports carry real messages.
vi.stubGlobal("MessageChannel", NodeMessageChannel);
afterEach(() => { document.body.innerHTML = ""; });

describe("runner configuration", () => {
  it("accepts exactly the pinned files and refuses anything else", () => {
    expect(acceptRunnerConfig(config())).not.toBeNull();
    const variants: ((c: RunnerConfig) => unknown)[] = [
      (c) => { c.assets[0]!.sha256 = "f".repeat(64); },
      (c) => { c.assets[2]!.size += 1; },
      (c) => { c.runtime.version = "0.29.5"; },
      (c) => { c.assets.pop(); },
      (c) => { c.assets.push({ ...c.assets[0]! }); },
      (c) => { c.assets[1]!.url = "https://cdn.example.org/pyodide.asm.mjs"; },
      (c) => { c.frameUrl = "//example.org/frame"; },
      (c) => { (c as { status: string }).status = "disabled"; },
      (c) => { c.limits.timeoutMs = 0; },
      // An inherited property of the pin list is not a pinned file.
      (c) => { c.assets[0] = { name: "constructor", url: "/api/python-runner/assets/314.0.7/constructor" } as never; },
      (c) => { delete (c.runtime as { license?: unknown }).license; },
    ];
    for (const change of variants) {
      const value = config();
      change(value);
      expect(acceptRunnerConfig(value)).toBeNull();
    }
  });
  it("keeps the pins and an accepted configuration unchangeable at run time", () => {
    const pin = PINNED_PYODIDE.files["pyodide.js"] as { sha256: string; size: number };
    expect(() => { pin.sha256 = "f".repeat(64); }).toThrow(TypeError);
    expect(() => { pin.size += 1; }).toThrow(TypeError);
    expect(() => { (PINNED_PYODIDE.files as Record<string, unknown>)["extra.js"] = { sha256: "f".repeat(64), size: 1 }; }).toThrow(TypeError);
    expect(Object.keys(PINNED_PYODIDE.files)).toHaveLength(5);
    const input = config(), expected = config(), accepted = acceptRunnerConfig(input)!;
    expect(accepted).toEqual(expected);
    // The accepted value is a copy: changing what the server sent changes nothing a run uses.
    input.limits.timeoutMs = 0;
    input.assets[0]!.url = "https://cdn.example.org/pyodide.js";
    input.runtime.license.source = "https://example.org/";
    expect(accepted).toEqual(expected);
    // And it cannot be changed itself.
    expect(() => { accepted.limits.timeoutMs = 0; }).toThrow(TypeError);
    expect(() => { accepted.assets[0]!.url = "https://cdn.example.org/pyodide.js"; }).toThrow(TypeError);
    expect(() => { accepted.assets.push({ ...accepted.assets[0]!, name: "extra.js" }); }).toThrow(TypeError);
    expect(() => { accepted.runtime.license.source = "https://example.org/"; }).toThrow(TypeError);
    expect(() => { accepted.frameUrl = "//example.org/frame"; }).toThrow(TypeError);
    expect(accepted).toEqual(expected);
  });
  it("hashes files the same way with and without Web Crypto (a plain-http page has none)", async () => {
    const bytes = new Uint8Array(200_003).map((_, i) => (i * 31) % 251), expected = createHash("sha256").update(bytes).digest("hex");
    expect(await sha256HexOfBytes(bytes)).toBe(expected);
    vi.stubGlobal("crypto", {});
    try { expect(await sha256HexOfBytes(bytes)).toBe(expected); } finally { vi.stubGlobal("crypto", webCrypto); }
  });
  it("refuses downloaded bytes whose size or SHA-256 differs from the pins in this bundle", async () => {
    const good = harness();
    const files = await fetchVerifiedFiles(config(), good.deps);
    expect(Object.keys(files).sort()).toEqual(Object.keys(PINNED_PYODIDE.files).sort());
    expect(good.fetch.mock.calls.every(([, init]) => (init as RequestInit).credentials === "omit")).toBe(true);
    const tampered = harness({ digest: async () => "0".repeat(64) });
    await expect(fetchVerifiedFiles(config(), tampered.deps)).rejects.toThrow("asset_integrity");
    const short = harness();
    short.fetch.mockImplementation(async () => new Response(new ArrayBuffer(3)));
    await expect(fetchVerifiedFiles(config(), short.deps)).rejects.toThrow("asset_integrity");
  });
});

describe("parent watchdog", () => {
  async function started(h: ReturnType<typeof harness>, runner: PythonPracticeRunner, output: string[] = []) {
    const result = runner.run("print(1)", null, { onOutput: (_stream, text) => output.push(text) });
    await h.hello();
    await settle();
    const load = h.received.find((m) => m.type === "load")!, run = h.received.find((m) => m.type === "run")!;
    expect(load).toBeTruthy();
    expect(run).toMatchObject({ code: "print(1)", input: null, timeoutMs: limits.timeoutMs, outputBytes: limits.outputBytes });
    await h.send({ type: "started", id: run.id });
    return { result, id: run.id as number };
  }
  it("creates one sandboxed, hidden frame and passes the run through", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps), output: string[] = [];
    const { result, id } = await started(h, runner, output);
    const frame = h.frame()!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`/api/python-runner/frame#${"N".repeat(24)}`);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.getAttribute("tabindex")).toBe("-1");
    await h.send({ type: "output", id, stream: "stdout", text: "1\n" });
    await h.send({ type: "output", id: id + 1, stream: "stdout", text: "not this run\n" });
    await h.send({ type: "done", id, status: "ok", durationMs: 12.4 });
    expect(await result).toEqual({ status: "ok", durationMs: 12, outputBytes: 2 });
    expect(output).toEqual(["1\n"]);
    // The interpreter stays loaded: the next run sends no files again.
    const second = runner.run("print(2)", "[1]", { onOutput: () => {} });
    await settle();
    expect(h.received.filter((m) => m.type === "load")).toHaveLength(1);
    const run = h.received.filter((m) => m.type === "run")[1]!;
    expect(run).toMatchObject({ code: "print(2)", input: "[1]" });
    await h.send({ type: "done", id: run.id, status: "error", durationMs: 3 });
    expect((await second).status).toBe("error");
  });
  it("removes a frame that does not report within the run limit plus grace", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps);
    const { result } = await started(h, runner);
    await h.advance(limits.timeoutMs + RUN_GRACE_MS - 1);
    expect(h.frame()).not.toBeNull();
    await h.advance(1);
    expect(await result).toMatchObject({ status: "timeout" });
    expect(h.frame()).toBeNull();
    expect(runner.running).toBe(false);
  });
  it("removes a frame that never says hello, and one that never finishes loading", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps);
    const result = runner.run("x = 1", null, { onOutput: () => {} });
    await h.advance(HANDSHAKE_TIMEOUT_MS);
    expect(await result).toMatchObject({ status: "unavailable", reason: "frame_timeout" });
    expect(h.frame()).toBeNull();
    const again = runner.run("x = 1", null, { onOutput: () => {} });
    await h.hello();
    await h.advance(LOAD_TIMEOUT_MS);
    expect(await again).toMatchObject({ status: "unavailable" });
    expect(h.frame()).toBeNull();
  });
  it("stop asks the frame first and removes it when it does not answer", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps);
    const { result } = await started(h, runner);
    runner.stop();
    await settle();
    expect(h.received.at(-1)).toMatchObject({ type: "stop" });
    await h.advance(STOP_GRACE_MS);
    expect(await result).toMatchObject({ status: "stopped" });
    expect(h.frame()).toBeNull();
  });
  it("caps output again on the page side and treats unknown statuses as a crash", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps), output: string[] = [];
    const { result, id } = await started(h, runner, output);
    await h.send({ type: "output", id, stream: "stderr", text: "x".repeat(100) });
    await h.send({ type: "output", id, stream: "stdout", text: "more" });
    await h.send({ type: "done", id, status: "passed", durationMs: "soon" });
    expect(output.join("")).toBe("x".repeat(64));
    expect(await result).toEqual({ status: "crashed", durationMs: 0, outputBytes: 64 });
  });
  it("answers busy to a second run and unavailable when the frame cannot load", async () => {
    const h = harness(), runner = new PythonPracticeRunner(config(), h.deps);
    const first = runner.run("x = 1", null, { onOutput: () => {} });
    expect(await runner.run("x = 2", null, { onOutput: () => {} })).toMatchObject({ status: "busy" });
    await h.hello();
    await h.send({ type: "load_failed", reason: "worker" });
    expect(await first).toMatchObject({ status: "unavailable", reason: "load_failed" });
    expect(h.frame()).toBeNull();
  });
  it("refuses tampered files before anything reaches the frame", async () => {
    const h = harness({ digest: async () => "0".repeat(64) }), runner = new PythonPracticeRunner(config(), h.deps);
    const result = runner.run("x = 1", null, { onOutput: () => {} });
    await h.hello();
    expect(await result).toMatchObject({ status: "unavailable", reason: "asset_integrity" });
    expect(h.received.some((m) => m.type === "load" || m.type === "run")).toBe(false);
  });
});

describe("practice runner panel", () => {
  function fakeHandle(results: RunResult[] = [{ status: "ok", durationMs: 420, outputBytes: 6 }]) {
    const handle: PracticeRunnerHandle & { calls: unknown[] } = {
      calls: [],
      limits: { timeoutMs: 10_000, outputBytes: 65_536, memoryBytes: 256 * 1024 * 1024, sourceBytes: 64_000 },
      runtime: { version: "314.0.7", license: { spdx: "MPL-2.0", source: "https://github.com/pyodide/pyodide/tree/314.0.7" } },
      run: vi.fn(async (code: string, input: string | null, callbacks) => {
        handle.calls.push({ code, input });
        callbacks.onPhase?.("running");
        callbacks.onOutput("stdout", "hello\n");
        callbacks.onOutput("stderr", "Traceback\n");
        return results.shift()!;
      }),
      stop: vi.fn(),
      reset: vi.fn(),
    };
    return handle;
  }
  it("runs, shows output in a log and announces the result", async () => {
    const handle = fakeHandle(), network = vi.spyOn(globalThis, "fetch");
    render(<PracticeRunner language="python" source={"print('hello')"} loadRunner={async () => handle} />);
    const run = await screen.findByRole("button", { name: "Run in browser" });
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    await pressWhenReady(run);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Finished in 0.4 s."));
    const log = screen.getByRole("log", { name: "Practice run output" });
    expect(log).toHaveTextContent("hello");
    expect(log.querySelector(".connected-practice-stderr")).toHaveTextContent("Traceback");
    expect(log).toHaveAttribute("tabindex", "0");
    expect(handle.calls).toEqual([{ code: "print('hello')", input: null }]);
    // A practice run never talks to the course server.
    expect(network).not.toHaveBeenCalled();
    await pressWhenReady(screen.getByRole("button", { name: "Reset Python" }));
    expect(handle.reset).toHaveBeenCalled();
    expect(screen.getByRole("log")).toHaveTextContent("Output appears here.");
  });
  it("checks the sample input is JSON before running", async () => {
    const handle = fakeHandle();
    render(<PracticeRunner language="python" source={"def solve(x):\n    return x"} loadRunner={async () => handle} />);
    const field = await screen.findByLabelText("Sample input for solve (JSON, optional)");
    fireEvent.change(field, { target: { value: "[1, 2" } });
    await pressWhenReady(screen.getByRole("button", { name: "Run in browser" }));
    expect(await screen.findByText("The sample input is not valid JSON. Example: [3, 1, 2]")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(handle.run).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "[1, 2]" } });
    await pressWhenReady(screen.getByRole("button", { name: "Run in browser" }));
    await waitFor(() => expect(handle.calls).toEqual([{ code: "def solve(x):\n    return x", input: "[1, 2]" }]));
  });
  it("stops a run, and stops it when the exercise goes away", async () => {
    let finish: (result: RunResult) => void = () => {};
    const handle = fakeHandle();
    handle.run = vi.fn(() => new Promise<RunResult>((resolve) => { finish = resolve; }));
    const view = render(<PracticeRunner language="python" source="while True: pass" loadRunner={async () => handle} />);
    await pressWhenReady(await screen.findByRole("button", { name: "Run in browser" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Run in browser" })).toBeDisabled();
    await pressWhenReady(screen.getByRole("button", { name: "Stop" }));
    expect(handle.stop).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "stopped", durationMs: 0, outputBytes: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("Stopped.");
    fireEvent.click(screen.getByRole("button", { name: "Run in browser" }));
    await waitFor(() => expect(handle.run).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(handle.stop).toHaveBeenCalledTimes(2);
  });
  it("is absent when the server offers no practice runs or the language is not Python", async () => {
    const none = vi.fn(async () => null);
    const { container, rerender } = render(<PracticeRunner language="python" source="x" loadRunner={none} />);
    await waitFor(() => expect(none).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    const handle = fakeHandle(), load = vi.fn(async () => handle);
    rerender(<PracticeRunner language="javascript" source="x" loadRunner={load} />);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
  it("words every limit in plain language", () => {
    const l = { timeoutMs: 5000, outputBytes: 65_536, memoryBytes: 256 * 1024 * 1024, sourceBytes: 64_000 };
    expect(resultMessage({ status: "timeout", durationMs: 0, outputBytes: 0 }, l)).toBe("Stopped: the run passed the 5 s time limit. Look for a loop that never ends.");
    expect(resultMessage({ status: "output_limit", durationMs: 0, outputBytes: 0 }, l)).toBe("Stopped: the output passed 64 KB. Print less, or print a summary.");
    expect(resultMessage({ status: "memory_limit", durationMs: 0, outputBytes: 0 }, l)).toBe("Stopped: the run needed more than 256 MB of memory.");
  });
});
