import assert from "node:assert/strict";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  distDigests,
  legacyDigests,
  UnidentifiableBuildError,
  type LegacyBasis,
} from "../scripts/dist-digest.js";

interface Released {
  integrity: string;
  headless: string;
  legacyBasis: LegacyBasis;
  identity?: string;
  typeOnlyDependencies?: string[];
  files?: Record<string, string>;
  headlessFiles: Record<string, string>;
}
interface Record_ {
  versions: Record<string, Released>;
  mislabeled: { version: string; integrity: string }[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const record = JSON.parse(
  await readFile(new URL("../released-digests.json", import.meta.url), "utf8"),
) as Record_;
const SDK = "@course-core/sdk";

async function built() {
  await stat(new URL("../dist/headless.js", import.meta.url)).catch(() => {
    throw new Error(
      "Build the package (npm run build) before checking its released digest.",
    );
  });
  const { version } = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as { version: string };
  return distDigests(
    root,
    record.versions[version]?.typeOnlyDependencies ?? [],
  );
}

test("the built package is exactly the recorded build for its version (any change needs a version bump)", async () => {
  const current = await built();
  const released = record.versions[current.version];
  assert.ok(
    released?.identity,
    `Version ${current.version} has no recorded identity in released-digests.json; record it with npm run digest`,
  );
  assert.deepEqual(
    current.files,
    released.files,
    `dist differs from the recorded ${current.version} build. Bump packages/visuals version instead of changing released bytes.`,
  );
  assert.deepEqual(current.headlessFiles, released.headlessFiles);
  assert.equal(current.identity, released.identity);
});

test("the recorded legacy fingerprints are re-derived from the current dist bytes, so courses that declare them get these exact bytes", async () => {
  const current = await built();
  const released = record.versions[current.version]!;
  assert.deepEqual(
    await legacyDigests(
      path.join(root, "dist"),
      current.version,
      released.legacyBasis,
    ),
    { integrity: released.integrity, headless: released.headless },
  );
  // The basis differs from today's manifest only in reviewed type-only pins.
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  ) as LegacyBasis;
  const strip = (map: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(map ?? {}).filter(
        ([name]) => !released.typeOnlyDependencies?.includes(name),
      ),
    );
  assert.deepEqual(
    strip(manifest.dependencies),
    strip(released.legacyBasis.dependencies),
  );
  assert.deepEqual(
    manifest.peerDependencies,
    released.legacyBasis.peerDependencies,
  );
});

test("the current version is the newest recorded release and distinct versions never share a fingerprint", async () => {
  const current = await built();
  const versions = Object.keys(record.versions);
  const newest = [...versions]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  assert.equal(current.version, newest);
  const all = Object.values(record.versions).flatMap((entry) =>
    entry.identity ? [entry.integrity, entry.identity] : [entry.integrity],
  );
  assert.equal(new Set(all).size, all.length);
  for (const bad of record.mislabeled) {
    assert.notEqual(record.versions[bad.version]?.integrity, bad.integrity);
    assert.ok(!all.includes(bad.integrity));
  }
  // Only the SDK, which src imports with `import type`, is reviewed as type-only.
  for (const entry of Object.values(record.versions))
    assert.deepEqual(entry.typeOnlyDependencies ?? [SDK], [SDK]);
});

test("0.1.1 served 0.1.0 on byte identity; from 0.2.0 the 0.1.x declarations are served on behavioural parity", async () => {
  const current = await built();
  const prior = record.versions["0.1.0"]!;
  assert.equal(
    prior.integrity,
    "sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24",
  );
  // The recorded fact the API's 0.1.1 -> 0.1.0 entry relied on.
  assert.deepEqual(
    record.versions["0.1.1"]!.headlessFiles,
    prior.headlessFiles,
  );
  assert.deepEqual(Object.keys(current.headlessFiles).sort(), [
    "equation.js",
    "expression.js",
    "features.js",
    "geometry.js",
    "headless.js",
    "markup.js",
    "runtime.js",
    "schema.js",
    "sdk.js",
    "svg.js",
  ]);
  // 0.2.0 changed the headless runtime. The API serves 0.1.0/0.1.1 declarations from it
  // only because 0.1.x scenes evaluate and render exactly as before (prior-parity.test.tsx)
  // and publication refuses any feature a 0.1.x build lacks. If either stops holding, the
  // API's reviewed prior builds must be reviewed again.
  assert.notDeepEqual(current.headlessFiles, prior.headlessFiles);
  // Modules the 0.1.x runtime used and 0.2.0 did not need to change stay byte-identical.
  for (const name of ["expression.js", "runtime.js", "sdk.js"])
    assert.equal(current.headlessFiles[name], prior.headlessFiles[name], name);
});

const scratchDirectories: string[] = [];
test.after(() =>
  Promise.all(
    scratchDirectories.map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);
type Change = (
  dir: string,
  manifest: Record<string, any>,
) => Promise<unknown> | unknown;
/** A scratch copy of the built package (dist + manifest) with one change applied. */
async function copy(change: Change, text?: (json: string) => string) {
  await built();
  const dir = await mkdtemp(path.join(tmpdir(), "visuals-digest-"));
  scratchDirectories.push(dir);
  await cp(path.join(root, "dist"), path.join(dir, "dist"), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  await change(dir, manifest);
  const json = JSON.stringify(manifest, null, 2);
  await writeFile(path.join(dir, "package.json"), text ? text(json) : json);
  return dir;
}
const identity = async (change: Change, typeOnly = [SDK]) =>
  (await distDigests(await copy(change), typeOnly)).identity;
const append = (file: string, text: string) => (dir: string) =>
  appendFile(path.join(dir, "dist", file), text);

test("only the pin of a reviewed type-only dependency may change without changing the identity", async () => {
  const current = await built();
  for (const pin of [
    "https://github.com/roeehrl/course-sdk/releases/download/v0.2.0/course-core-sdk-0.2.0.tgz",
    "https://github.com/roeehrl/course-sdk/releases/download/v9.9.9/course-core-sdk-9.9.9.tgz",
  ]) {
    const dir = await copy((_, manifest) => {
      manifest.dependencies[SDK] = pin;
    });
    const moved = await distDigests(dir, [SDK]);
    assert.equal(moved.identity, current.identity);
    // Without the reviewed list every pin counts.
    assert.notEqual((await distDigests(dir)).identity, current.identity);
  }
  // The pin of the recorded legacy basis gives the recorded legacy fingerprint.
  const released = await distDigests(
    await copy((_, manifest) => {
      manifest.dependencies[SDK] =
        record.versions[current.version]!.legacyBasis.dependencies![SDK];
    }),
    [SDK],
  );
  assert.equal(released.integrity, record.versions[current.version]!.integrity);
});

test("every other change to dist or the manifest changes the identity", async () => {
  const current = await built();
  const changes: [string, Change][] = [
    ["zod pin", (_, m) => void (m.dependencies.zod = "3.25.75")],
    ["react peer range", (_, m) => void (m.peerDependencies.react = "^19.0.0")],
    ["devDependency", (_, m) => void (m.devDependencies.vite = "7.0.0")],
    ["headless file", append("runtime.js", "\n")],
    ["client file", append("react.js", "\n")],
    ["declaration file", append("headless.d.ts", "\n")],
    ["added file", (dir) => writeFile(path.join(dir, "dist", "extra.js"), "")],
    [
      "export map target",
      (_, m) => void (m.exports["./headless"].import = "./dist/index.js"),
    ],
    [
      "export condition order",
      (_, m) => {
        const { types, import: entry } = m.exports["./headless"];
        m.exports["./headless"] = { import: entry, types };
      },
    ],
  ];
  for (const [label, change] of changes)
    assert.notEqual(await identity(change), current.identity, label);
  // An entry that is not dist/headless.js is hashed like any other file (two contents, two identities).
  const mjs = (body: string) => async (dir: string, m: Record<string, any>) => {
    m.exports["./headless"].import = "./dist/headless.mjs";
    await writeFile(path.join(dir, "dist", "headless.mjs"), body);
  };
  assert.notEqual(
    await identity(mjs("export const a = 1;\n")),
    await identity(mjs("export const a = 2;\n")),
  );
});

test("a build whose loading the lint cannot follow is refused, not under-hashed", async () => {
  const refused: [string, Change, ((json: string) => string)?][] = [
    [
      "mixed quotes",
      append("headless.js", `\nimport "./schema.js'/../../outside.js";\n`),
    ],
    [
      "escaped specifier",
      append("headless.js", '\nimport "./\\x2e\\x2e/o.js";\n'),
    ],
    ["parent directory", append("headless.js", '\nimport "../outside.js";\n')],
    [
      "dynamic import",
      append("runtime.js", '\nexport const x = () => import("zod");\n'),
    ],
    [
      "import.meta split",
      append("runtime.js", "\nexport const u = import\n.meta;\n"),
    ],
    ["require", append("runtime.js", '\nexport const x = require("zod");\n')],
    [
      "builtin",
      append("headless.js", '\nimport { Module } from "node:module";\n'),
    ],
    [
      "getBuiltinModule",
      append(
        "headless.js",
        '\nexport const m = process.getBuiltinModule("module");\n',
      ),
    ],
    ["eval", append("headless.js", '\nexport const e = (0, eval)("1");\n')],
    [
      "Function",
      append("headless.js", '\nexport const f = Function("return 1");\n'),
    ],
    [
      "constructor",
      append("headless.js", "\nexport const f = (() => 1).constructor;\n"),
    ],
    ["WebAssembly", append("headless.js", "\nexport const w = WebAssembly;\n")],
    [
      "worker",
      append("react.js", '\nexport const w = () => new Worker("x.js");\n'),
    ],
    [
      "script injection",
      append(
        "react.js",
        '\nexport const s = () => document.createElement("script");\n',
      ),
    ],
    [
      "comment-split import",
      append("headless.js", '\nexport * from /* x */ "zod";\n'),
    ],
    ["undeclared package", append("headless.js", '\nimport "left-pad";\n')],
    [
      "type-only dependency imported",
      append("headless.js", '\nimport "@course-core/sdk";\n'),
    ],
    [
      "type-only dependency named",
      append(
        "headless.js",
        '\nexport const n = "@course-core/" + "sdk" + "@course-core/sdk";\n',
      ),
    ],
    ["CSS import", append("styles.css", '\n@import "x.css";\n')],
    ["CSS url", append("styles.css", "\na { background: url(x.png); }\n")],
    ["native addon", (dir) => writeFile(path.join(dir, "dist", "x.node"), "")],
    ["CommonJS file", (dir) => writeFile(path.join(dir, "dist", "x.cjs"), "")],
    [
      "symlink",
      (dir) =>
        symlink(
          path.join(dir, "dist", "headless.js"),
          path.join(dir, "dist", "link.js"),
        ),
    ],
    [
      "entry outside dist",
      (_, m) => void (m.exports["./headless"].import = "./outside.js"),
    ],
    [
      "entry not hashed",
      (_, m) => void (m.exports["./headless"].import = "./dist/missing.js"),
    ],
    ["entry pattern", (_, m) => void (m.exports["./*"] = "./dist/*.js")],
    [
      "line continuation in a specifier",
      append("headless.js", '\nimport "../outsi\\\nde.js";\n'),
    ],
    [
      "line continuation hiding the type-only name",
      append("headless.js", '\nimport "@course-core/s\\\ndk";\n'),
    ],
    ["template specifier", append("headless.js", "\nimport `./schema.js`;\n")],
    [
      "code importing a declaration file",
      append("headless.js", '\nimport "./headless.d.ts";\n'),
    ],
    [
      "runtime entry naming a declaration file",
      (_, m) => void (m.exports["./headless"].import = "./dist/headless.d.ts"),
    ],
    [
      "declaration importing outside dist",
      append("headless.d.ts", '\nimport "../outside.js";\n'),
    ],
    ["global object", append("headless.js", '\nglobal["ev" + "al"]("1");\n')],
    [
      "computed constructor",
      append(
        "headless.js",
        '\nexport const F = (async () => {})["constructor"];\n',
      ),
    ],
    [
      "reflective call",
      append("headless.js", '\nReflect.apply(Function, null, ["x"]);\n'),
    ],
    [
      "escaped manifest key",
      () => undefined,
      (json) => json.replace('"type": "module"', '"\\u0074ype": "module"'),
    ],
    ["module type other than module", (_, m) => void (m.type = "commonjs")],
    ["no module type", (_, m) => void delete m.type],
    [
      "aliased require",
      append(
        "headless.js",
        '\nvar q = typeof require === "function" ? require : null;\n',
      ),
    ],
    ["module binding", append("headless.js", "\nvar r = module.require;\n")],
    ["exports binding", append("headless.js", "\nexports.x = 1;\n")],
    ["__dirname", append("headless.js", "\nexport const d = __dirname;\n")],
    [
      "nested types condition",
      (_, m) =>
        void (m.exports["./headless"] = {
          types: { default: "./dist/headless.d.ts" },
          import: "./dist/headless.js",
        }),
    ],
    [
      "duplicate manifest key",
      () => undefined,
      (json) =>
        json.replace(
          '"type": "module"',
          '"type": "commonjs", "type": "module"',
        ),
    ],
  ];
  for (const [label, change, text] of refused)
    await assert.rejects(
      distDigests(await copy(change, text), [SDK]),
      UnidentifiableBuildError,
      label,
    );
});
