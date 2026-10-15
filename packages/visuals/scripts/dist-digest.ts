import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Copy of services/api/src/visuals-identity.ts; renderer-compatibility.test.ts runs both on the same builds.
/**
 * Package identity of an installed visuals build (scheme course-core-visuals-package-v2).
 * Keep in step with packages/visuals/scripts/dist-digest.ts (a copy of this module plus the
 * legacy digests); renderer-compatibility.test.ts runs both on the same builds and checks
 * them against packages/visuals/released-digests.json.
 *
 * It hashes every file under `dist` (any allowed extension; symlinks, special files and other
 * extensions refuse the build) and the parsed manifest in its own key order (duplicate keys
 * refuse it). Every manifest entry point must be a hashed file inside `dist`. Nothing is left
 * out, except the pins of the `typeOnly` dependencies a recorded release names after review
 * of its fixed bytes; no dist file may refer to them.
 *
 * The lint below refuses loading it does not follow. It supports review of fixed, recorded
 * bytes; it is not a proof about arbitrary code, which is why only recorded releases get the
 * type-only relaxation and only they can serve other declarations.
 */
export class UnidentifiableBuildError extends Error {}
const refuse = (reason: string): never => {
  throw new UnidentifiableBuildError(reason);
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Manifest = { [key: string]: Json };
export interface PackageIdentity {
  identity: string;
  files: Record<string, string>;
  headlessFiles: Record<string, string>;
}

const IDENTITY_SCHEME = "course-core-visuals-package-v2";
const ALLOWED_FILE = /\.(?:js|mjs|css|json|d\.ts|d\.mts)$/;
const CODE_FILE = /\.m?js$/;
const RUNTIME_TARGET = /(?<!\.d)\.(?:m?js|json)$/;
const SPECIFIER =
  /\b(?:from|import)\s*(["'])((?:(?!\1)[^\n\r\u2028\u2029])*)\1/g;
/** Every place a static specifier could start; each must be a complete SPECIFIER match. */
const SPECIFIER_START = /\b(?:from|import)\s*["'`]/g;
/** A backslash before a line terminator continues a string literal across lines. */
const LINE_CONTINUATION = /\\(?:\r\n?|[\n\u2028\u2029])/;
const DECLARATION_FILE = /\.d\.m?ts$/;
const UNCLEAN_SPECIFIER = /[\\'"`?#%\s\x00-\x1f\x7f]/;
const PACKAGE_SPECIFIER =
  /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/;
const REFUSED_CODE: readonly [RegExp, string][] = [
  [/\b(?:from|import)\s*(?:\/\*|\/\/)/, "comment inside an import"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bimport\s*\.\s*meta\b/, "import.meta"],
  [/\brequire\s*[(.[]/, "require"],
  [/\bcreateRequire\b/, "createRequire"],
  [/\bgetBuiltinModule\b/, "process.getBuiltinModule"],
  [/\bprocess\b/, "process"],
  [/\bglobalThis\b|\bglobal\b|\bself\b|\bwindow\s*\[/, "global object access"],
  [
    /\[\s*["'`][^\]\n]*["'`]\s*\+|\[\s*["'`]constructor["'`]\s*\]/,
    "computed member name",
  ],
  [
    /\bFunction\b|\bReflect\s*\.\s*(?:apply|construct|get|getOwnPropertyDescriptor)\b/,
    "Function or reflective call",
  ],
  [/\beval\b/, "eval"],
  [/\.\s*constructor\b/, "constructor access"],
  [
    /\b(?:Shared)?Worker\b|\bimportScripts\b|\bserviceWorker\b|\baddModule\b/,
    "worker or worklet",
  ],
  [/\b_load\b|\bdlopen\b|\bregister\s*\(/, "module loader hook"],
  [/\bWebAssembly\b/, "WebAssembly"],
  [
    /\bcreateElement\b|\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write|\bsrcdoc\b/,
    "markup or script injection",
  ],
  [/\bcreateObjectURL\b|\bjavascript:/i, "generated script URL"],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "string timer"],
];
const REFUSED_STYLE = /@import\b|\burl\s*\(|\bexpression\s*\(/i;
const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** JSON.parse that refuses duplicate object keys (Node would silently take the last one). */
export function parseManifest(raw: string): Manifest {
  let index = 0;
  const space = () => {
    while (/\s/.test(raw[index] ?? "")) index++;
  };
  const string = (): string => {
    const start = index++;
    while (raw[index] !== '"') {
      if (index >= raw.length) refuse("package.json: unterminated string");
      index += raw[index] === "\\" ? 2 : 1;
    }
    index++;
    return JSON.parse(raw.slice(start, index)) as string;
  };
  const value = (): void => {
    space();
    const char = raw[index];
    if (char === "{" || char === "[") {
      const close = char === "{" ? "}" : "]",
        keys = new Set<string>();
      index++;
      space();
      if (raw[index] === close) {
        index++;
        return;
      }
      for (;;) {
        if (char === "{") {
          space();
          if (raw[index] !== '"') refuse("package.json: expected a key");
          if (raw.slice(index + 1, raw.indexOf('"', index + 1)).includes("\\"))
            refuse("package.json: escaped key");
          const key = string();
          if (keys.has(key)) refuse(`package.json: duplicate key ${key}`);
          keys.add(key);
          space();
          if (raw[index++] !== ":") refuse("package.json: expected ':'");
        }
        value();
        space();
        if (raw[index] === ",") {
          index++;
          continue;
        }
        if (raw[index++] !== close) refuse(`package.json: expected '${close}'`);
        return;
      }
    }
    if (char === '"') {
      string();
      return;
    }
    const literal =
      /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        raw.slice(index),
      );
    if (!literal) refuse("package.json: invalid JSON");
    index += literal![0].length;
  };
  value();
  space();
  if (index !== raw.length) refuse("package.json: trailing content");
  const parsed = JSON.parse(raw) as Json;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    refuse("package.json: not an object");
  return parsed as Manifest;
}

/** Every file under dist as posix path -> bytes, sorted. Refuses anything but directories and allowed regular files. */
export async function visualsDistFiles(
  directory: string,
): Promise<Map<string, Buffer>> {
  if (!(await lstat(directory)).isDirectory())
    refuse("dist is not a real directory");
  const files = new Map<string, Buffer>();
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await collect(name);
      else if (!entry.isFile()) refuse(`${name}: not a regular file`);
      else if (!ALLOWED_FILE.test(entry.name))
        refuse(`${name}: unexpected file type`);
      else files.set(name, await readFile(path.join(directory, name)));
    }
  }
  await collect("");
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function entryTargets(manifest: Manifest, files: ReadonlyMap<string, Buffer>) {
  const all: string[] = [],
    headless: string[] = [];
  const target = (value: string, into: string[][], types: boolean) => {
    const match = /^\.\/dist\/(.+)$/.exec(value);
    if (
      match &&
      !types &&
      !RUNTIME_TARGET.test(match[1]!) &&
      !/\.css$/.test(match[1]!)
    )
      refuse(
        `package.json: entry ${value} is not a .js, .mjs, .json or .css file`,
      );
    if (
      !match ||
      UNCLEAN_SPECIFIER.test(value) ||
      value.includes("*") ||
      match[1]!.split("/").some((part) => part === ".." || part === ".")
    )
      refuse(`package.json: entry ${JSON.stringify(value)} is not a dist file`);
    if (!files.has(match![1]!))
      refuse(`package.json: entry ${value} is not a hashed file`);
    for (const list of into) list.push(match![1]!);
  };
  // Only a "types" condition (which Node never selects) may name a declaration file.
  const walk = (
    value: Json | undefined,
    into: string[][],
    types = false,
  ): void => {
    if (value === undefined || value === null || value === false) return;
    if (typeof value === "string") return target(value, into, types);
    if (Array.isArray(value))
      return value.forEach((item) => walk(item, into, types));
    if (typeof value === "object")
      return Object.entries(value).forEach(([key, item]) =>
        walk(item, into, types || key === "types"),
      );
    refuse("package.json: unexpected entry value");
  };
  for (const field of ["main", "module", "browser", "imports"] as const)
    walk(manifest[field], [all]);
  const exports = manifest.exports;
  if (exports && typeof exports === "object" && !Array.isArray(exports))
    for (const [key, value] of Object.entries(exports))
      walk(value, key === "./headless" ? [all, headless] : [all]);
  else walk(exports, [all]);
  return { all, headless: headless.filter((name) => CODE_FILE.test(name)) };
}

/**
 * Lints one file; returns the dist files it imports. Declaration files are checked for
 * clean specifiers only (they contain type-level `import("…")` queries); nothing may load
 * them, because entries and code imports must name .js/.mjs/.json files.
 */
function lint(
  name: string,
  text: string,
  files: ReadonlyMap<string, Buffer>,
  manifest: Manifest,
  typeOnly: readonly string[],
): string[] {
  const declaration = DECLARATION_FILE.test(name);
  if (/\.json$/.test(name)) return [];
  if (LINE_CONTINUATION.test(text)) refuse(`${name}: line continuation`);
  if (/\.css$/.test(name)) {
    for (const pkg of typeOnly)
      if (text.includes(pkg))
        refuse(`${name}: refers to type-only dependency ${pkg}`);
    if (REFUSED_STYLE.test(text)) refuse(`${name}: CSS import or url()`);
    return [];
  }
  if (!CODE_FILE.test(name) && !declaration) return [];
  if (!declaration) {
    // A declaration may name a type-only dependency; code may not, anywhere.
    for (const pkg of typeOnly)
      if (text.includes(pkg))
        refuse(`${name}: refers to type-only dependency ${pkg}`);
    for (const [pattern, label] of REFUSED_CODE)
      if (pattern.test(text)) refuse(`${name}: ${label}`);
  }
  const declared = (pkg: string) =>
    [
      manifest.dependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
      ...(declaration ? [manifest.devDependencies] : []),
    ].some(
      (map) =>
        !!map &&
        typeof map === "object" &&
        !Array.isArray(map) &&
        Object.hasOwn(map, pkg),
    );
  const matches = [...text.matchAll(SPECIFIER)];
  if (matches.length !== [...text.matchAll(SPECIFIER_START)].length)
    refuse(`${name}: an import specifier is not a plain one-line string`);
  const imported: string[] = [];
  for (const match of matches) {
    const specifier = match[2]!;
    if (specifier === "" || UNCLEAN_SPECIFIER.test(specifier))
      refuse(`${name}: unclean specifier ${JSON.stringify(specifier)}`);
    if (specifier.startsWith(".")) {
      if (
        !specifier.startsWith("./") ||
        specifier
          .split("/")
          .slice(1)
          .some((part) => part === ".." || part === ".")
      )
        refuse(`${name}: relative import ${specifier} leaves its directory`);
      const target = path.posix.join(path.posix.dirname(name), specifier);
      if (!files.has(target))
        refuse(`${name}: imports ${specifier}, which is not a hashed file`);
      if (!RUNTIME_TARGET.test(target))
        refuse(
          `${name}: imports ${specifier}, which is not a .js, .mjs or .json file`,
        );
      if (!declaration) imported.push(target);
      continue;
    }
    if (!PACKAGE_SPECIFIER.test(specifier))
      refuse(`${name}: specifier ${specifier} is not a package import`);
    const parts = specifier.split("/"),
      pkg = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    if (!declared(pkg) || (!declaration && typeOnly.includes(pkg)))
      refuse(
        `${name}: imports ${pkg}, which is not a declared run-time dependency`,
      );
  }
  return imported;
}

/** The package identity of a dist directory and its manifest text, without the pins of `typeOnly` dependencies. */
export async function visualsPackageIdentity(
  directory: string,
  manifestText: string,
  typeOnly: readonly string[] = [],
): Promise<PackageIdentity> {
  const manifest = parseManifest(manifestText),
    files = await visualsDistFiles(directory),
    entries = entryTargets(manifest, files);
  const imports = new Map<string, string[]>();
  for (const [name, bytes] of files)
    imports.set(
      name,
      lint(name, bytes.toString("utf8"), files, manifest, typeOnly),
    );
  const closure = new Set<string>();
  const follow = (name: string) => {
    if (closure.has(name)) return;
    closure.add(name);
    for (const next of imports.get(name) ?? []) follow(next);
  };
  entries.headless.forEach(follow);
  const hashed = structuredClone(manifest),
    dependencies = hashed.dependencies;
  if (
    dependencies &&
    typeof dependencies === "object" &&
    !Array.isArray(dependencies)
  )
    for (const pkg of typeOnly) delete dependencies[pkg];
  const digests = [...files].map(
    ([name, bytes]) => [name, sha256(bytes)] as const,
  );
  return {
    identity: `sha256-${sha256(`${IDENTITY_SCHEME}\0${JSON.stringify({ files: digests, manifest: hashed })}`)}`,
    files: Object.fromEntries(digests),
    headlessFiles: Object.fromEntries(
      digests.filter(([name]) => closure.has(name)),
    ),
  };
}
// End of the copy.

/** The manifest fields the legacy fingerprints hash besides the dist bytes. */
export interface LegacyBasis {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
export interface LegacyDigests {
  integrity: string;
  headless: string;
}
export interface DistDigests extends LegacyDigests, PackageIdentity {
  version: string;
}
const LEGACY_FILE = /\.(?:js|css|json)$/;
const LEGACY_RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g;
export const packageIdentity = visualsPackageIdentity;

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
  const names: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && LEGACY_FILE.test(entry.name))
        names.push(name.replaceAll(path.sep, "/"));
    }
  }
  await collect("");
  const whole = createHash("sha256");
  for (const name of names.sort())
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
  const closure = new Set<string>();
  async function follow(name: string) {
    if (closure.has(name)) return;
    closure.add(name);
    const text = await readFile(path.join(directory, name), "utf8");
    for (const match of text.matchAll(LEGACY_RELATIVE_IMPORT))
      await follow(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(name), match[1]!),
        ),
      );
  }
  await follow("headless.js");
  const headless = createHash("sha256");
  for (const name of [...closure].sort())
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

export async function distDigests(
  packageRoot: string,
  typeOnly: readonly string[] = [],
): Promise<DistDigests> {
  const directory = path.join(packageRoot, "dist");
  const text = await readFile(path.join(packageRoot, "package.json"), "utf8");
  const manifest = parseManifest(text) as Manifest &
    LegacyBasis & {
      version: string;
    };
  // Identify (and lint) first: the legacy closure walk assumes every import is a dist file.
  const identity = await visualsPackageIdentity(directory, text, typeOnly);
  return {
    version: manifest.version,
    ...(await legacyDigests(directory, manifest.version, manifest)),
    ...identity,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
  const record = JSON.parse(
    await readFile(
      new URL("../released-digests.json", import.meta.url),
      "utf8",
    ),
  ) as { versions: Record<string, { typeOnlyDependencies?: string[] }> };
  const { version } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { version: string };
  console.log(
    JSON.stringify(
      await distDigests(
        root,
        record.versions[version]?.typeOnlyDependencies ?? [],
      ),
      null,
      2,
    ),
  );
}
