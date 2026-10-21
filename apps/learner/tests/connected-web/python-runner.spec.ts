import { createServer, type Server } from "node:net";
import { expect, test, type Locator, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

/* N02: browser practice runs of Python on the real connected host (Chromium at phone, tablet and
 * desktop sizes; the engines config repeats this on WebKit). Pyodide runs in Core's sandboxed
 * runner frame, an opaque origin with connect-src 'none', inside a worker the frame's watchdog
 * terminates. A practice run sends nothing to the server and never becomes evidence. */

async function listen() {
  let connections = 0;
  const server: Server = createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, connections: () => connections, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function openCodeCheck(page: Page) {
  const signed = await page.request.post("/test/code-session");
  expect(signed.ok()).toBe(true);
  await page.goto(`/#signin=${(await signed.json()).token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const resume = page.getByRole("button", { name: "Continue learning →", exact: true });
  const roadmap = page.getByRole("heading", { name: "Your learning path", exact: true });
  await expect(roadmap).toBeVisible();
  await expect(async () => {
    if (await resume.count()) await resume.click({ timeout: 2_000 });
    await expect(roadmap).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await fill(page.getByRole("textbox", { name: "Your numeric answer", exact: true }), "4");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Your code", exact: true })).toBeVisible();
}
async function fill(box: Locator, value: string) {
  await box.fill(value);
  // WebKit occasionally drops the first input event on a freshly mounted field.
  if ((await box.inputValue()) !== value) await box.fill(value);
  await expect(box).toHaveValue(value);
}
async function recorded(page: Page) {
  return page.evaluate(async () => {
    const id = (await (await fetch("/api/enrollments", { credentials: "same-origin" })).json())[0].id as string;
    const exported = await (await fetch(`/api/enrollments/${id}/export`, { credentials: "same-origin" })).json();
    const size = (value: { items?: unknown[] } | unknown[]) => (Array.isArray(value) ? value.length : value.items?.length ?? 0);
    return { attempts: size(exported.attempts), evidence: size(exported.evidence), activityEvidence: size(exported.activities.evidence), observations: size(exported.activities.observations) };
  });
}

test("Python runs in the browser for practice only: output, limits, no network, no parent access, no evidence", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const listener = await listen();
  try {
    await openCodeCheck(page);
    const before = await recorded(page);
    expect(before.attempts).toBeGreaterThan(0);
    // Everything the page does from here on, by origin and method.
    const requests: { url: string; method: string }[] = [];
    page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
    // The parent's own secrets: a cookie and both storages of Core's origin.
    await page.evaluate(() => {
      document.cookie = "parent_secret=c00kie-s3cret; path=/; SameSite=Strict";
      localStorage.setItem("parent_secret", "local-s3cret");
      sessionStorage.setItem("parent_secret", "session-s3cret");
    });

    const editor = page.getByRole("textbox", { name: "Your code", exact: true });
    const practice = page.getByRole("region", { name: "Practice run in your browser" });
    const run = practice.getByRole("button", { name: "Run in browser", exact: true });
    const stop = practice.getByRole("button", { name: "Stop", exact: true });
    const status = practice.getByRole("status");
    const output = practice.getByRole("log", { name: "Practice run output" });
    await expect(run).toBeEnabled();
    await expect(stop).toBeDisabled();

    // 1. print(), started from the keyboard. The first run loads the pinned Pyodide files.
    await fill(editor, 'print("hello from", "Pyodide", 6 * 7)\n');
    await run.focus();
    await page.keyboard.press("Enter");
    await expect(status).toHaveText(/^Finished in /, { timeout: 90_000 });
    await expect(output).toHaveText("hello from Pyodide 42\n");
    const frame = page.locator('iframe[data-testid="python-runner-frame"]');
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame).toHaveAttribute("aria-hidden", "true");

    // 2. The exercise protocol with a sample input, and a traceback for a learner error.
    await fill(editor, "def solve(values):\n    return sorted(values)[0]\n");
    await fill(practice.getByLabel("Sample input for solve (JSON, optional)"), "[5, 3, 9]");
    await run.click();
    await expect(status).toHaveText(/^Finished in /);
    await expect(output).toHaveText("solve(sample input) returned: 3\n");
    await fill(practice.getByLabel("Sample input for solve (JSON, optional)"), "");
    await fill(editor, "values = []\nprint(values[1])\n");
    await run.click();
    await expect(status).toHaveText(/^Finished with an error/);
    await expect(output).toContainText('File "<your code>", line 2');
    await expect(output).toContainText("IndexError: list index out of range");

    // 3. No network: every route out is refused and nothing reaches a local listener.
    const target = `127.0.0.1:${listener.port}`;
    await fill(editor, [
      "import builtins, js",
      `url = "http://${target}/probe"`,
      "def attempt(label, action):",
      "    try:",
      "        action()",
      "        print(label + ': reached')",
      "    except BaseException as error:",
      "        print(label + ': blocked')",
      "def xhr():",
      "    request = js.XMLHttpRequest.new()",
      "    request.open('GET', url, False)",
      "    request.send()",
      "attempt('xhr', xhr)",
      `attempt('websocket', lambda: js.WebSocket.new("ws://${target}/probe"))`,
      "attempt('importScripts', lambda: js.importScripts(url))",
      "attempt('worker', lambda: js.Worker.new(url))",
      "attempt('urllib', lambda: __import__('urllib.request').request.urlopen(url, timeout=1))",
      `attempt('socket', lambda: __import__('socket').create_connection(("127.0.0.1", ${listener.port}), 1))`,
      "builtins.fetch_probe = []",
      "js.fetch(url).then(lambda r: builtins.fetch_probe.append('reached'), lambda e: builtins.fetch_probe.append('blocked'))",
      "",
    ].join("\n"));
    await run.click();
    await expect(status).toHaveText(/^Finished in /);
    for (const label of ["xhr", "websocket", "importScripts", "worker", "urllib", "socket"]) await expect(output).toContainText(`${label}: blocked`);
    await expect(output).not.toContainText("reached");
    await fill(editor, "import builtins\nprint('fetch:', builtins.fetch_probe)\n");
    await run.click();
    await expect(output).toHaveText("fetch: ['blocked']\n");
    await page.waitForTimeout(1000);
    expect(listener.connections(), "connections from the runner").toBe(0);

    // 4. No access to the parent's origin, cookies, storage or document.
    await fill(editor, [
      "import js",
      "print('origin=' + str(js.self.origin))",
      "for name in ['document', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'parent', 'top', 'opener', 'cookieStore']:",
      "    try:",
      "        value = getattr(js, name)",
      "        print(name + ': ' + ('absent' if value is None else 'present'))",
      "    except AttributeError:",
      "        print(name + ': absent')",
      "",
    ].join("\n"));
    await run.click();
    await expect(status).toHaveText(/^Finished in /);
    await expect(output).toContainText("origin=null");
    await expect(output).not.toContainText("present");
    await expect(output).not.toContainText("s3cret");
    const runnerFrame = page.frames().find((candidate) => candidate.url().includes("/api/python-runner/frame"))!;
    expect(runnerFrame).toBeTruthy();
    expect(await runnerFrame.evaluate(() => {
      const probe = (read: () => unknown) => { try { return `readable:${String(read())}`; } catch (error) { return `blocked:${(error as Error).name}`; } };
      return { origin: self.origin, cookie: probe(() => document.cookie), local: probe(() => localStorage.getItem("parent_secret")),
        session: probe(() => sessionStorage.getItem("parent_secret")), parent: probe(() => window.parent.document.title) };
    })).toEqual({ origin: "null", cookie: "blocked:SecurityError", local: "blocked:SecurityError", session: "blocked:SecurityError", parent: "blocked:SecurityError" });

    // 5. The watchdog terminates a runaway loop at the host's 3 s limit; the next run starts fresh.
    await fill(editor, "print('looping')\nwhile True:\n    pass\n");
    const started = Date.now();
    await run.click();
    await expect(status).toHaveText("Stopped: the run passed the 3 s time limit. Look for a loop that never ends.", { timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    await expect(output).toHaveText("looping\n");
    await fill(editor, "print('fresh interpreter')\n");
    await run.click();
    await expect(status).toHaveText(/^Finished in /, { timeout: 60_000 });
    await expect(output).toHaveText("fresh interpreter\n");

    // 6. Stop, the output cap and the memory guard.
    await fill(editor, "while True:\n    pass\n");
    await run.click();
    await expect(stop).toBeEnabled();
    await expect(status).toHaveText("Running…");
    await stop.click();
    await expect(status).toHaveText("Stopped.");
    await fill(editor, "for i in range(10 ** 7):\n    print(i)\n");
    await run.click();
    await expect(status).toHaveText("Stopped: the output passed 64 KB. Print less, or print a summary.", { timeout: 60_000 });
    expect(new TextEncoder().encode((await output.textContent()) ?? "").length).toBeLessThanOrEqual(65_536);
    await fill(editor, "data = bytearray(600 * 1024 * 1024)\nprint(len(data))\n");
    await run.click();
    await expect(status).toHaveText("Stopped: the run needed more than 256 MB of memory.", { timeout: 60_000 });
    await expect(output).toContainText("MemoryError");

    // 7. Practice never reached the server: no writes, nothing but Core's own files, no new records.
    const apiWrites = requests.filter((r) => r.method !== "GET" && new URL(r.url).pathname.startsWith("/api/"));
    expect(apiWrites).toEqual([]);
    expect(requests.filter((r) => /^https?:/.test(r.url) && !r.url.startsWith(`${baseURL}/`))).toEqual([]);
    expect(requests.some((r) => r.url.includes("/api/python-runner/assets/"))).toBe(true);
    expect(await recorded(page)).toEqual(before);

    // 8. Reset, layout at this viewport and accessibility of the whole lesson with output shown.
    await practice.getByRole("button", { name: "Reset Python", exact: true }).click();
    await expect(status).toHaveText("Python was reset. The next run starts a fresh interpreter.");
    await expect(frame).toHaveCount(0);
    await fill(editor, "print('after reset')\n");
    await run.click();
    await expect(output).toHaveText("after reset\n", { timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const control of [run, stop, practice.getByRole("button", { name: "Reset Python", exact: true }), practice.getByLabel("Sample input for solve (JSON, optional)")]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await listener.close();
  }
});
