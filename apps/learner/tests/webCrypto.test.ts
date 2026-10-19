import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId, sha256Bytes, sha256Hex } from "../src/client/webCrypto";

// On a plain-http, non-loopback origin (for example a tailnet IP) the page is not a
// secure context: browsers remove crypto.randomUUID and crypto.subtle there but keep
// crypto.getRandomValues. These tests run the helpers in exactly that shape.
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const real = globalThis.crypto;
function insecureContextCrypto(getRandomValues: Crypto["getRandomValues"] | null = real.getRandomValues.bind(real)) {
  vi.stubGlobal("crypto", getRandomValues ? { getRandomValues } : {});
}
afterEach(() => vi.unstubAllGlobals());

describe("randomId", () => {
  it("uses crypto.randomUUID when the page has it", () => {
    const spy = vi.spyOn(real, "randomUUID");
    expect(randomId()).toMatch(V4);
    expect(spy).toHaveBeenCalledOnce();
  });
  it("builds an RFC 4122 v4 UUID from getRandomValues on a non-secure page", () => {
    insecureContextCrypto();
    const ids = new Set(Array.from({ length: 2000 }, randomId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(V4);
  });
  it("sets exactly the version and variant bits", () => {
    insecureContextCrypto(((bytes: Uint8Array) => bytes.fill(0xff)) as Crypto["getRandomValues"]);
    expect(randomId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    insecureContextCrypto(((bytes: Uint8Array) => bytes.fill(0)) as Crypto["getRandomValues"]);
    expect(randomId()).toBe("00000000-0000-4000-8000-000000000000");
  });
  it("refuses, rather than using Math.random, when no cryptographic source exists", () => {
    insecureContextCrypto(null);
    const math = vi.spyOn(Math, "random");
    expect(() => randomId()).toThrow(/no cryptographic random number generator/);
    expect(math).not.toHaveBeenCalled();
  });
});

describe("sha256", () => {
  const inputs = ["", "abc", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "é ✓ 漢字 🙂", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)];
  it("matches Node's SHA-256 in plain JavaScript, including padding boundaries", () => {
    for (const text of inputs) {
      const bytes = new TextEncoder().encode(text);
      expect(Buffer.from(sha256Bytes(bytes)).toString("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });
  it("gives the same hex with and without crypto.subtle", async () => {
    for (const text of inputs) {
      const expected = createHash("sha256").update(text).digest("hex");
      expect(await sha256Hex(text)).toBe(expected);
      insecureContextCrypto();
      expect(await sha256Hex(text)).toBe(expected);
      vi.unstubAllGlobals();
    }
  });
});

describe("source guard", () => {
  // Secure-context-only APIs must go through src/client/webCrypto.ts (or, for the
  // clipboard, a call site that handles its absence). Direct use breaks every action
  // on a plain-http tailnet or LAN address.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|jsx?|mjs)$/.test(name) ? [path] : [];
  });
  it("finds no crypto.randomUUID, crypto.subtle, unchecked navigator.clipboard, service worker, storage manager or Notification use outside the helper", () => {
    const offenders = files(root)
      .filter((file) => !file.endsWith(join("client", "webCrypto.ts")))
      .flatMap((file) => readFileSync(file, "utf8").split("\n").map((line, i) => ({ file, line, i })))
      .filter(({ line }) => /\brandomUUID\b|\.subtle\b|\bsubtle\s*\.|navigator\.clipboard\.|\bserviceWorker\b|navigator\.storage\b|\bNotification\b/.test(line))
      .map(({ file, i, line }) => `${relative(root, file)}:${i + 1}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
