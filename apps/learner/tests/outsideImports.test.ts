import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The learner CI job installs only the learner's own dependencies, yet `tsc` checks every
// file the app or its tests import by relative path, including ones elsewhere in the repo
// (the connected tests' renderer-health check lives in services/api/browser). A package
// import in such a file resolves locally, where every module is installed, and fails only
// in CI. So every file reached outside apps/learner may import only node builtins and
// further relative files.

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(m?ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1]!);
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, "index.ts")];
  return candidates.find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

const inside = (path: string) => !relative(app, path).startsWith("..");

/** Files outside the app that the app's sources reach by relative import, each with the
 * package imports it makes. */
function outsideFiles() {
  const found = new Map<string, string[]>();
  const pending = sources(app);
  const seen = new Set(pending);
  while (pending.length) {
    const file = pending.pop()!;
    const packages: string[] = [];
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        if (!specifier.startsWith("node:")) packages.push(specifier);
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
    if (!inside(file)) found.set(relative(app, file), packages);
  }
  return found;
}

describe("files the learner app imports from elsewhere in the repo", () => {
  it("finds the import forms a package import can take", () => {
    expect(
      specifiers(`import type { Page } from "@playwright/test";\nimport "./side";\nexport { x } from '../y.js';\nconst m = await import("zod");`),
    ).toEqual(["@playwright/test", "./side", "../y.js", "zod"]);
  });

  it("reaches the renderer-health check, and it and every other such file import no package", () => {
    const found = outsideFiles();
    expect([...found.keys()]).toContain(join("..", "..", "services", "api", "browser", "renderer-health.ts"));
    expect(Object.fromEntries([...found].filter(([, packages]) => packages.length))).toEqual({});
  });
});
