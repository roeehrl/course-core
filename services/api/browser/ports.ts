import { execFileSync } from "node:child_process";

/** Loopback ports for the connected browser host (`browser/start.ts`).
 *
 * The main host serves http://127.0.0.1:<port>; the passkey host serves
 * http://localhost:<passkeyPort> (WebAuthn refuses IP-address relying parties).
 *
 * - `COURSE_BROWSER_PORT` / `COURSE_BROWSER_PASSKEY_PORT` override either port.
 * - `COURSE_BROWSER_PORTS=fixed` keeps the defaults 4317 / 4318 for unset ports;
 *   `COURSE_BROWSER_PORTS=free` uses free loopback ports chosen by the OS, so
 *   parallel checkouts can run the suite at the same time.
 * - Without `COURSE_BROWSER_PORTS`, CI (`CI=true`) is fixed and everything else free.
 *   Root commands run children with CI=true, so scripts/orchestrate.mjs sets the
 *   mode from the caller's own CI status.
 *
 * The chosen values are written back to `process.env`, so the web server command
 * and Playwright workers (which inherit the runner's environment) agree on them. */
export const DEFAULT_BROWSER_PORT = 4317;
export const DEFAULT_PASSKEY_PORT = 4318;

export function parsePort(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} must be a TCP port between 1 and 65535, got ${JSON.stringify(value)}`);
  return port;
}

/** Asks the OS for distinct free loopback ports. Synchronous because Playwright
 * configuration files are evaluated synchronously. */
export function freeLoopbackPorts(count: number): number[] {
  const script = `
    const net = require("node:net"), servers = [];
    const next = () => {
      if (servers.length === ${count}) {
        process.stdout.write(servers.map((s) => s.address().port).join(" "));
        return servers.forEach((s) => s.close());
      }
      const s = net.createServer();
      s.once("error", (e) => { console.error(e.message); process.exit(1); });
      s.listen(0, "127.0.0.1", () => { servers.push(s); next(); });
    };
    next();`;
  const ports = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" })
    .trim().split(" ").map(Number);
  if (ports.length !== count || ports.some((p) => !Number.isInteger(p) || p < 1))
    throw new Error("Could not allocate free loopback ports for the browser host");
  return ports;
}

export function browserPorts(env: NodeJS.ProcessEnv = process.env): { port: number; passkeyPort: number } {
  let port = parsePort("COURSE_BROWSER_PORT", env.COURSE_BROWSER_PORT);
  let passkeyPort = parsePort("COURSE_BROWSER_PASSKEY_PORT", env.COURSE_BROWSER_PASSKEY_PORT);
  const mode = env.COURSE_BROWSER_PORTS || (env.CI === "true" ? "fixed" : "free");
  if (mode !== "fixed" && mode !== "free")
    throw new Error(`COURSE_BROWSER_PORTS must be "fixed" or "free", got ${JSON.stringify(mode)}`);
  if (mode === "fixed") {
    port ??= DEFAULT_BROWSER_PORT;
    passkeyPort ??= DEFAULT_PASSKEY_PORT;
  } else if (port === undefined || passkeyPort === undefined) {
    const free = freeLoopbackPorts(2).filter((p) => p !== port && p !== passkeyPort);
    port ??= free.shift()!;
    passkeyPort ??= free.shift()!;
  }
  if (port === passkeyPort)
    throw new Error(`COURSE_BROWSER_PORT and COURSE_BROWSER_PASSKEY_PORT must differ (both ${port})`);
  env.COURSE_BROWSER_PORT = String(port);
  env.COURSE_BROWSER_PASSKEY_PORT = String(passkeyPort);
  return { port, passkeyPort };
}
