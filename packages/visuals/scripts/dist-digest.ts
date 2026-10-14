import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Digests of a built visuals package. `integrity` is byte-for-byte the
 * fingerprint the API's svgRenderer() advertises and that courses declare for
 * `course-core-svg-v1`; `headless` covers only the server-side headless entry
 * (headless.js and every dist module it imports) plus the dependency manifest.
 */
export interface DistDigests {
  version: string;
  integrity: string;
  headless: string;
  /** sha256 hex of each file in the headless entry closure. */
  headlessFiles: Record<string, string>;
}

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g;

export async function distDigests(packageRoot: string): Promise<DistDigests> {
  const directory = path.join(packageRoot, "dist");
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as Manifest;

  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && /\.(?:js|css|json)$/.test(entry.name))
        files.push(name);
    }
  }
  await collect("");
  const whole = createHash("sha256");
  for (const name of files.sort())
    whole
      .update(name.replaceAll(path.sep, "/"))
      .update("\0")
      .update(await readFile(path.join(directory, name)))
      .update("\0");
  whole.update(
    JSON.stringify({
      version: manifest.version,
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    }),
  );

  const closure = new Set<string>();
  async function follow(name: string) {
    if (closure.has(name)) return;
    closure.add(name);
    const text = await readFile(path.join(directory, name), "utf8");
    for (const match of text.matchAll(RELATIVE_IMPORT))
      await follow(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(name), match[1]!),
        ),
      );
  }
  await follow("headless.js");
  const headlessFiles: Record<string, string> = {};
  const headless = createHash("sha256");
  for (const name of [...closure].sort()) {
    const bytes = await readFile(path.join(directory, name));
    headlessFiles[name] = createHash("sha256").update(bytes).digest("hex");
    headless.update(name).update("\0").update(bytes).update("\0");
  }
  headless.update(
    JSON.stringify({
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    }),
  );

  return {
    version: manifest.version,
    integrity: `sha256-${whole.digest("hex")}`,
    headless: `sha256-${headless.digest("hex")}`,
    headlessFiles,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  console.log(JSON.stringify(await distDigests(root), null, 2));
}
