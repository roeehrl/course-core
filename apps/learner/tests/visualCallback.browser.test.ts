// @vitest-environment node
// Actual component mount with installed SDK/visuals, no fixture renderer and no
// ConnectedHost/provider wiring. The host intentionally recreates its callback.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "vite";
import { chromium, type Browser } from "@playwright/test";
import type { VisualInteractionContext } from "../src/components/VisualBlock";

let server: Server, browser: Browser, origin: string;
beforeAll(async () => {
  const app = path.resolve(import.meta.dirname, "..");
  const require = createRequire(import.meta.url);
  const entry = path.join(app, "visual-callback-browser.tsx");
  const code = `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {VisualBlock} from './src/components/VisualBlock.web';
      import {visualContextFixture} from './tests/visualContext.fixture';
      const fixture=visualContextFixture();window.changes=[];
      function Host(){
        const [source,setSource]=useState({episodeId:'lesson-one',blockId:'diagram-one',episodeTitle:'Lesson one'});
        const [unsupported,setUnsupported]=useState(false),[mounted,setMounted]=useState(true),[context,setContext]=useState(null);
        return <main>
          <button onClick={()=>setSource({episodeId:'lesson-two',blockId:'diagram-two',episodeTitle:'Lesson two'})}>Change lesson</button>
          <button onClick={()=>setUnsupported(true)}>Unknown renderer</button>
          <button onClick={()=>setMounted(false)}>Remove illustration</button>
          {mounted&&<VisualBlock experience={unsupported?{...fixture,rendererId:'future-renderer'}:fixture} source={source} onContextChange={change=>{
            window.changes.push(change);
            if(change.kind==='frame')setContext(change.context);
            else setContext(old=>old&&change.source&&old.episodeId===change.source.episodeId&&old.blockId===change.source.blockId&&old.visualId===change.source.visualId?null:old);
          }}/>}
          <output id="current-context">{context?JSON.stringify(context):'none'}</output>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Host/>);
    `;
  const built = await build({
    configFile: false, root: app, logLevel: "error", mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    plugins: [{ name: "in-memory-visual-callback-host", resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return code; } }],
    resolve: { alias: { "react-native": path.dirname(require.resolve("react-native-web/package.json")), react: path.dirname(require.resolve("react/package.json")), "react-dom": path.dirname(require.resolve("react-dom/package.json")) } },
    define: { "process.env.NODE_ENV": '\"production\"' },
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "app" } },
  });
  const bundle = Array.isArray(built) ? built[0]! : built;
  if (!("output" in bundle)) throw new Error("Expected an in-memory bundle");
  const scriptAsset = bundle.output.find(file => file.type === "chunk");
  const cssAsset = bundle.output.find(file => file.type === "asset" && file.fileName.endsWith(".css"));
  if (scriptAsset?.type !== "chunk" || cssAsset?.type !== "asset") throw new Error("Expected script and styles");
  const script = scriptAsset.code, css = cssAsset.source;
  server = createServer((request, response) => {
    if (request.url === "/app.js") response.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
    else if (request.url === "/app.css") response.writeHead(200, { "Content-Type": "text/css" }).end(css);
    else response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css"><style>body{margin:0}main{max-width:1000px;padding:16px;margin:auto}output{display:block;overflow-wrap:anywhere}button{min-height:36px}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local test address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: process.env.CI === "true" ? undefined : "chrome", args: ["--disable-gpu"] });
}, 30000);
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

describe("real VisualBlock callbacks in Chrome", () => {
  it.each([390, 834, 1440])("controls, keyboard, resize, timeline, reduced motion and invalidation at %ipx", async width => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 1000, reducedMotion: "no-preference" });
    await context.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    try {
      await page.goto(origin);
      expect(errors).toEqual([]);
      await page.locator('#current-context').waitFor({state:'visible',timeout:3000});
      await page.waitForFunction(() => { const value=document.querySelector("#current-context")?.textContent; return Boolean(value && value !== "none"); },undefined,{timeout:3000});
      page.setDefaultTimeout(5000);
      const current = async (): Promise<VisualInteractionContext> => JSON.parse((await page.locator("#current-context").textContent())!);
      expect((await current()).visualId).toBe("context-study");
      expect((await current()).sceneFingerprint).toMatch(/^\d+-[a-f0-9]+-[a-f0-9]+$/);
      const amount = page.getByRole("slider", { name: "Amount", exact: true });
      await amount.focus(); await amount.press("ArrowRight");
      await expect.poll(async () => (await current()).state.amount).toBe(2.5);
      await page.getByRole("checkbox", { name: "Show result", exact: true }).uncheck();
      await expect.poll(async () => (await current()).state.enabled).toBe(false);
      await page.getByRole("combobox", { name: "Rule", exact: true }).selectOption("square");
      await expect.poll(async () => (await current()).state.mode).toBe("square");
      const timeline = page.getByRole("slider", { name: "Timeline", exact: true });
      await timeline.fill("400"); await timeline.focus(); await timeline.press("ArrowRight");
      await expect.poll(async () => (await current()).timeMs).toBe(410);
      await page.setViewportSize({ width: width < 500 ? 960 : 390, height: 900 });
      await page.waitForFunction(expected => JSON.parse(document.querySelector("#current-context")!.textContent!).layout === expected, width < 500 ? "expanded" : "compact");
      expect((await current()).state).toEqual({ amount: 2.5, enabled: false, mode: "square" });
      await expect.poll(async () => (await current()).timeMs).toBe(410);
      await page.getByRole("button", { name: "Play animation", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(document.querySelector("#current-context")!.textContent!).timeMs > 410);
      await page.getByRole("button", { name: "Pause animation", exact: true }).click();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => JSON.parse(document.querySelector("#current-context")!.textContent!).reducedMotion);
      await expect.poll(async () => (await current()).timeMs).toBe(750);
      expect(await page.getByRole("button", { name: "Play animation", exact: true }).isDisabled()).toBe(true);
      await timeline.fill("200"); await expect.poll(async () => (await current()).timeMs).toBe(200);
      await expect.poll(async () => (await current()).reducedMotion).toBe(true);
      // Returning the source to another lesson resets the view and invalidates
      // the old source, even if the same asset ID occurs in both lessons.
      await page.getByRole("button", { name: "Change lesson", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(document.querySelector("#current-context")!.textContent!).episodeId === "lesson-two");
      await expect.poll(async () => (await current()).state.amount).toBe(2);
      expect(await page.getByText(/Current illustration · Lesson two · A measured change/).isVisible()).toBe(true);
      await page.getByRole("button", { name: "Unknown renderer", exact: true }).click();
      await expect.poll(async () => page.locator("#current-context").textContent()).toBe("none");
      expect(await page.locator("svg.ccv-scene").count()).toBe(0);
      const before = await page.evaluate(() => (window as unknown as { changes: unknown[] }).changes.length);
      await page.getByRole("button", { name: "Remove illustration", exact: true }).click();
      const events = await page.evaluate(() => (window as unknown as { changes: { kind: string; reason?: string; source?: { episodeId: string } }[] }).changes);
      expect(events.length).toBeGreaterThan(before);
      expect(events.at(-1)).toMatchObject({ kind: "unavailable", reason: "unmounted", source: { episodeId: "lesson-two" } });
      expect(events.length).toBeLessThan(120); // Parent state updates must not loop.
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
