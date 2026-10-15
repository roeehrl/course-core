import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Digests of a built visuals package.
 *
 * Executed identity (what actually runs):
 * - `files` / `headlessFiles`: sha256 hex of each runtime dist file (`.js`, `.css`,
 *   `.json`) of the whole package / of the headless entry closure.
 * - `runtime` / `headlessRuntime`: for every package those files import at run time,
 *   the manifest pin it resolves through. Packages the dist never imports (for example
 *   `@course-core/sdk`, which the sources use for types only) are not part of it.
 * - `executed` / `headlessExecuted`: domain-separated digests of the above plus the
 *   manifest fields that decide how those files are loaded (`type`, `exports`, ...).
 *
 * Legacy fingerprints (unchanged algorithm, still what courses declare):
 * - `integrity` is byte-for-byte the fingerprint released versions were recorded with;
 *   `headless` is the legacy headless digest. Both also hash the whole `dependencies`
 *   map, so a dependency pin that no dist file imports still moves them.
 */
export interface DistDigests extends LegacyDigests {
  version: string;
  files: Record<string, string>;
  headlessFiles: Record<string, string>;
  runtime: Record<string, RuntimePin>;
  headlessRuntime: Record<string, RuntimePin>;
  executed: string;
  headlessExecuted: string;
}

export interface LegacyDigests {
  integrity: string;
  headless: string;
}

/** The manifest pins a run-time import resolves through. */
export interface RuntimePin {
  dependency?: string;
  peer?: string;
  optional?: string;
}

/** The manifest fields the legacy fingerprints hash besides the dist bytes. */
export interface LegacyBasis {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Manifest extends LegacyBasis {
  version: string;
  optionalDependencies?: Record<string, string>;
  [field: string]: unknown;
}

/** Manifest fields that decide how dist files are resolved and loaded. */
const LOADING_FIELDS = [
  "type",
  "main",
  "module",
  "browser",
  "exports",
  "imports",
  "sideEffects",
] as const;
const EXECUTED_SCHEME = "course-core-visuals-executed-v1";
const RUNTIME_FILE = /\.(?:js|css|json)$/;
const SPECIFIER = /(?:\bfrom|\bimport)\s*["']([^"']*)["']/g;
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g;
/** Module loading this scanner cannot follow statically. Any occurrence refuses the build. */
const UNANALYSABLE =
  /\b(?:from|import)\s*(?:\/\*|\/\/)|\bimport\s*\(|\brequire\s*\(|\bimport\.meta\b|\bcreateRequire\b|\bimportScripts\b|\bnew\s+Worker\b/;

export class UnanalysableBuildError extends Error {}

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The package a bare specifier names: `react/jsx-runtime` -> `react`, `@a/b/c` -> `@a/b`. */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

async function listRuntimeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && RUNTIME_FILE.test(entry.name))
        files.push(name.replaceAll(path.sep, "/"));
    }
  }
  await collect("");
  return files.sort();
}

/** headless.js and every dist module it reaches through `./` imports (legacy closure rule). */
async function headlessClosure(directory: string): Promise<string[]> {
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
  return [...closure].sort();
}

const declared = (manifest: Manifest) => [
  ...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]),
];
const pinOf = (pkg: string, manifest: Manifest) =>
  JSON.parse(
    canonicalJson({
      dependency: manifest.dependencies?.[pkg],
      peer: manifest.peerDependencies?.[pkg],
      optional: manifest.optionalDependencies?.[pkg],
    }),
  ) as RuntimePin;
const quotedSpecifier = (pkg: string) =>
  new RegExp(`["'\`]${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["'\`/]`);

/**
 * The run-time imports of a set of dist files, as package -> manifest pin. Fails closed:
 * dynamic or computed loading, a relative import outside the given file set, a URL or
 * absolute specifier, a CSS @import and an undeclared package all throw.
 */
function runtimeImports(
  texts: Map<string, string>,
  manifest: Manifest,
): Record<string, RuntimePin> {
  const pins: Record<string, RuntimePin> = {};
  for (const [name, text] of texts) {
    if (name.endsWith(".json")) continue;
    if (name.endsWith(".css")) {
      if (/@import\b/.test(text))
        throw new UnanalysableBuildError(
          `${name}: CSS @import is not analysed`,
        );
      continue;
    }
    if (UNANALYSABLE.test(text))
      throw new UnanalysableBuildError(
        `${name}: dynamic or computed module loading cannot be analysed`,
      );
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(name), specifier),
        );
        if (!texts.has(target))
          throw new UnanalysableBuildError(
            `${name}: imports ${specifier}, which is outside the hashed files`,
          );
        continue;
      }
      if (specifier.startsWith("node:")) {
        pins[specifier] = {};
        continue;
      }
      if (
        !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/.test(
          specifier,
        )
      )
        throw new UnanalysableBuildError(
          `${name}: specifier ${JSON.stringify(specifier)} is not a package import`,
        );
      const pkg = packageName(specifier);
      if (!declared(manifest).includes(pkg))
        throw new UnanalysableBuildError(
          `${name}: imports ${pkg}, which the manifest does not declare`,
        );
      pins[pkg] = pinOf(pkg, manifest);
    }
    // Over-approximate: any declared package whose name appears as a quoted specifier
    // anywhere in the file (an import the pattern above did not see, or a string) is bound.
    for (const pkg of declared(manifest))
      if (quotedSpecifier(pkg).test(text)) pins[pkg] = pinOf(pkg, manifest);
  }
  return Object.fromEntries(
    Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function loading(manifest: Manifest): Record<string, unknown> {
  return Object.fromEntries(
    LOADING_FIELDS.map((field) => [field, manifest[field]]),
  );
}

/** The executed-identity digest of one file set. `version` is omitted for the headless closure. */
export function executedDigest(input: {
  part: "package" | "headless";
  version?: string;
  files: Record<string, string>;
  runtime: Record<string, RuntimePin>;
  loading: Record<string, unknown>;
}): string {
  return `sha256-${sha256(canonicalJson({ scheme: EXECUTED_SCHEME, ...input }))}`;
}

/**
 * The legacy fingerprints, computed from dist bytes and an explicit manifest basis. With
 * the recorded basis of a released version this re-derives that version's recorded
 * `integrity`/`headless` from the bytes on disk, which proves those bytes are the
 * released ones whatever the current dependency pins say.
 */
export async function legacyDigests(
  directory: string,
  version: string,
  basis: LegacyBasis,
): Promise<LegacyDigests> {
  const whole = createHash("sha256");
  for (const name of await listRuntimeFiles(directory))
    whole
      .update(name)
      .update("\0")
      .update(await readFile(path.join(directory, name)))
      .update("\0");
  whole.update(
    JSON.stringify({
      version,
      dependencies: basis.dependencies,
      peerDependencies: basis.peerDependencies,
    }),
  );
  const headless = createHash("sha256");
  for (const name of await headlessClosure(directory))
    headless
      .update(name)
      .update("\0")
      .update(await readFile(path.join(directory, name)))
      .update("\0");
  headless.update(
    JSON.stringify({
      dependencies: basis.dependencies,
      peerDependencies: basis.peerDependencies,
    }),
  );
  return {
    integrity: `sha256-${whole.digest("hex")}`,
    headless: `sha256-${headless.digest("hex")}`,
  };
}

export async function distDigests(packageRoot: string): Promise<DistDigests> {
  const directory = path.join(packageRoot, "dist");
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as Manifest;

  const names = await listRuntimeFiles(directory);
  const bytes = new Map<string, Buffer>();
  for (const name of names)
    bytes.set(name, await readFile(path.join(directory, name)));
  const closure = await headlessClosure(directory);

  const subset = (list: readonly string[]) =>
    new Map(list.map((name) => [name, bytes.get(name)!.toString("utf8")]));
  const digests = (list: readonly string[]) =>
    Object.fromEntries(list.map((name) => [name, sha256(bytes.get(name)!)]));

  const files = digests(names);
  const headlessFiles = digests(closure);
  const runtime = runtimeImports(subset(names), manifest);
  const headlessRuntime = runtimeImports(subset(closure), manifest);
  const legacy = await legacyDigests(directory, manifest.version, manifest);

  return {
    version: manifest.version,
    ...legacy,
    files,
    headlessFiles,
    runtime,
    headlessRuntime,
    executed: executedDigest({
      part: "package",
      version: manifest.version,
      files,
      runtime,
      loading: loading(manifest),
    }),
    headlessExecuted: executedDigest({
      part: "headless",
      files: headlessFiles,
      runtime: headlessRuntime,
      loading: loading(manifest),
    }),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  console.log(JSON.stringify(await distDigests(root), null, 2));
}
