import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { browserPorts, freeLoopbackPorts, parsePort } from '../browser/ports.js';

describe('connected browser host ports', () => {
  it('keeps the fixed 4317/4318 ports in CI', () => {
    const env: NodeJS.ProcessEnv = { CI: 'true' };
    expect(browserPorts(env)).toEqual({ port: 4317, passkeyPort: 4318 });
    expect(env).toMatchObject({ COURSE_BROWSER_PORT: '4317', COURSE_BROWSER_PASSKEY_PORT: '4318' });
  });

  it('honours explicit overrides in CI and locally', () => {
    for (const CI of ['true', undefined]) {
      const env: NodeJS.ProcessEnv = { CI, COURSE_BROWSER_PORT: '5517', COURSE_BROWSER_PASSKEY_PORT: '5518' };
      expect(browserPorts(env)).toEqual({ port: 5517, passkeyPort: 5518 });
    }
  });

  it('allocates distinct free loopback ports locally and exports them for workers', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { port, passkeyPort } = browserPorts(env);
    expect(port).not.toBe(passkeyPort);
    expect([port, passkeyPort]).not.toContain(0);
    expect(env).toMatchObject({ COURSE_BROWSER_PORT: String(port), COURSE_BROWSER_PASSKEY_PORT: String(passkeyPort) });
    // A second evaluation (a Playwright worker re-loading the config) reuses the choice.
    expect(browserPorts(env)).toEqual({ port, passkeyPort });
    for (const chosen of [port, passkeyPort]) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(chosen, '127.0.0.1', resolve); });
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fills only the missing port locally and never repeats the overridden one', () => {
    const [taken] = freeLoopbackPorts(1);
    const env: NodeJS.ProcessEnv = { COURSE_BROWSER_PORT: String(taken) };
    const { port, passkeyPort } = browserPorts(env);
    expect(port).toBe(taken);
    expect(passkeyPort).not.toBe(taken);
  });

  it('lets COURSE_BROWSER_PORTS choose the mode regardless of CI', () => {
    expect(browserPorts({ COURSE_BROWSER_PORTS: 'fixed' })).toEqual({ port: 4317, passkeyPort: 4318 });
    // Root commands run children with CI=true; a local caller still gets free ports.
    const free = browserPorts({ CI: 'true', COURSE_BROWSER_PORTS: 'free' });
    expect([free.port, free.passkeyPort]).not.toContain(4317);
    expect(free.port).not.toBe(free.passkeyPort);
    expect(() => browserPorts({ COURSE_BROWSER_PORTS: 'random' })).toThrow(/must be "fixed" or "free"/);
  });

  it('rejects malformed or clashing ports', () => {
    for (const bad of ['0', '65536', '-1', '4317.5', 'abc', ' 4317', '1e3'])
      expect(() => parsePort('COURSE_BROWSER_PORT', bad)).toThrow(/COURSE_BROWSER_PORT must be a TCP port/);
    expect(parsePort('COURSE_BROWSER_PORT', '')).toBeUndefined();
    expect(() => browserPorts({ CI: 'true', COURSE_BROWSER_PORT: '4318' })).toThrow(/must differ/);
    expect(() => browserPorts({ COURSE_BROWSER_PORT: '6000', COURSE_BROWSER_PASSKEY_PORT: '6000' })).toThrow(/must differ/);
  });
});
