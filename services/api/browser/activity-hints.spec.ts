// The reviewer's WebKit egress: <link rel=preconnect> opens TCP connections to script-chosen hosts
// and ports despite the frame CSP. A local listener counts connections while a sandboxed probe
// builds network hints through every DOM entry point. Runs on Chromium and (engines config) WebKit.
import { createServer, type Server } from "node:net";
import { expect, test } from "@playwright/test";

async function listen() {
  let connections = 0;
  const server: Server = createServer((socket) => { connections++; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, connections: () => connections, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("network hints from a sandboxed activity never reach the network", async ({ page, browser, browserName, request }) => {
  const listener = await listen();
  try {
    // Control (WebKit, the engine that leaks): the same hint in an ordinary page does connect, so
    // the listener would see a leak. Chromium does not preconnect to loopback from such a page.
    if (browserName === "webkit") {
      const control = await browser.newPage();
      await control.setContent(`<link rel="preconnect" href="http://127.0.0.1:${listener.port}/">`);
      await expect.poll(listener.connections, { timeout: 10_000 }).toBeGreaterThan(0);
      await control.close();
    }
    const baseline = listener.connections();

    const fixture = await (await request.post("/test/hint-session", { data: { port: listener.port } })).json();
    await page.goto(`/#signin=${fixture.token}`);
    await page.getByRole("button", { name: "Open course", exact: true }).click();
    await page.getByRole("button", { name: "Start course", exact: true }).click();
    await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
    await expect(page.locator("section.connected-placement")).toHaveCount(0);
    await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
    const report = async () => page.evaluate(async () => {
      const id = (await (await fetch("/api/enrollments", { credentials: "same-origin" })).json())[0].id as string;
      const exported = await (await fetch(`/api/enrollments/${id}/export`, { credentials: "same-origin" })).json();
      return exported.activities.observations.items.find((o: { observation: { kind: string } }) => o.observation.kind === "hints")?.observation ?? null;
    });
    await expect.poll(report, { timeout: 20_000 }).not.toBeNull();
    // Give any hint (including the document.write tried after the report) time to connect.
    await page.waitForTimeout(2000);
    expect(listener.connections() - baseline, "connections from the sandboxed frame").toBe(0);
    const frame = page.frameLocator('iframe[title="Hint probe (interactive activity)"]');
    await expect(frame.getByRole("status")).toHaveText("Reported: not_evaluated; write blocked:NotAllowedError");
    const observed = await report();
    // No hint link and no nested document ever entered the frame's document, whatever the entry point.
    expect(observed).toMatchObject({ hints: 0, frames: 0, equiv: 0 });
    for (const name of ["relSetter", "setAttribute", "setAttributeNS", "attrNode", "attrValue", "namedItem", "rangeInsert", "replaceChildren", "tableCaption", "srcdoc", "designMode",
      "stringObjectName", "toStringName", "stringObjectNameNS", "toStringNameNS", "flipDesignMode",
      "metaSetAttribute", "metaSetAttributeNS", "metaAttrNode", "metaNamedItem", "metaProperty"])
      expect(observed.results[name], name).toMatch(/^blocked:/);
    // A value whose toString flips is converted once: the harmless first answer is what was set,
    // so these succeed and still leave no hint (hints: 0 above).
    for (const name of ["flipSetAttribute", "flipSetAttributeNS", "flipRel", "flipAttrValue", "flipNodeValue", "flipTextContent", "metaFlipName"])
      expect(observed.results[name], name).toBe("done");
  } finally {
    await listener.close();
  }
});
