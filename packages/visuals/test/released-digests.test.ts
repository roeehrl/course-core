import assert from "node:assert/strict";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  distDigests,
  legacyDigests,
  UnanalysableBuildError,
  type LegacyBasis,
  type RuntimePin,
} from "../scripts/dist-digest.js";

interface Released {
  integrity: string;
  headless: string;
  legacyBasis: LegacyBasis;
  executed: string;
  headlessExecuted: string;
  files: Record<string, string>;
  headlessFiles: Record<string, string>;
  runtime: Record<string, RuntimePin>;
  headlessRuntime: Record<string, RuntimePin>;
}
interface Record_ {
  versions: Record<string, Released>;
  mislabeled: { version: string; integrity: string }[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
const record = JSON.parse(
  await readFile(new URL("../released-digests.json", import.meta.url), "utf8"),
) as Record_;

async function current() {
  await stat(new URL("../dist/headless.js", import.meta.url)).catch(() => {
    throw new Error(
      "Build the package (npm run build) before checking its released digest.",
    );
  });
  return distDigests(root);
}

test("the built dist executes exactly the recorded build for its version (any executed change needs a version bump)", async () => {
  const built = await current();
  const released = record.versions[built.version];
  assert.ok(
    released,
    `Version ${built.version} has no entry in released-digests.json; record it with npm run digest`,
  );
  assert.deepEqual(
    built.files,
    released.files,
    `dist differs from the recorded ${built.version} build. Bump packages/visuals version instead of changing released bytes.`,
  );
  assert.deepEqual(built.headlessFiles, released.headlessFiles);
  assert.deepEqual(
    built.runtime,
    released.runtime,
    "A package the dist imports at run time changed its pin. That changes executed code: bump the version.",
  );
  assert.deepEqual(built.headlessRuntime, released.headlessRuntime);
  assert.equal(built.executed, released.executed);
  assert.equal(built.headlessExecuted, released.headlessExecuted);
});

test("the recorded legacy fingerprints are re-derived from the current dist bytes, so courses that declare them get these exact bytes", async () => {
  const built = await current();
  const released = record.versions[built.version]!;
  const directory = path.join(root, "dist");
  assert.deepEqual(
    await legacyDigests(directory, built.version, released.legacyBasis),
    { integrity: released.integrity, headless: released.headless },
  );
  // The basis may differ from today's manifest only in packages no dist file imports.
  for (const [name, pin] of Object.entries(built.runtime)) {
    if (pin.dependency)
      assert.equal(released.legacyBasis.dependencies?.[name], pin.dependency);
    if (pin.peer)
      assert.equal(released.legacyBasis.peerDependencies?.[name], pin.peer);
  }
});

test("the current version is the newest recorded release and distinct versions never share a fingerprint", async () => {
  const built = await current();
  const versions = Object.keys(record.versions);
  const newest = [...versions]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  assert.equal(built.version, newest);
  for (const field of ["integrity", "executed"] as const) {
    const values = Object.values(record.versions).map((entry) => entry[field]);
    assert.equal(new Set(values).size, values.length, field);
  }
  const all = Object.values(record.versions).flatMap((entry) => [
    entry.integrity,
    entry.executed,
  ]);
  assert.equal(new Set(all).size, all.length);
  for (const bad of record.mislabeled) {
    assert.notEqual(record.versions[bad.version]?.integrity, bad.integrity);
    assert.ok(!all.includes(bad.integrity));
  }
});

test("the server-side headless runtime is byte-identical to released 0.1.0 (basis for the API's reviewed prior build)", async () => {
  const built = await current();
  const prior = record.versions["0.1.0"]!;
  assert.equal(
    prior.integrity,
    "sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24",
  );
  assert.deepEqual(Object.keys(built.headlessFiles).sort(), [
    "expression.js",
    "geometry.js",
    "headless.js",
    "runtime.js",
    "schema.js",
    "sdk.js",
  ]);
  // If this fails, the API's reviewed prior build for 0.1.0 no longer applies:
  // pinned 0.1.0 courses would be refused. Changing that is a deliberate review.
  assert.deepEqual(built.headlessFiles, prior.headlessFiles);
  assert.deepEqual(built.headlessRuntime, prior.headlessRuntime);
  assert.equal(built.headlessExecuted, prior.headlessExecuted);
  assert.equal(
    (
      await legacyDigests(
        path.join(root, "dist"),
        built.version,
        prior.legacyBasis,
      )
    ).headless,
    prior.headless,
  );
});

/** A scratch copy of the built package (dist + manifest) to change one thing in. */
async function copy(
  change: (dir: string, manifest: Record<string, any>) => Promise<void> | void,
) {
  await current();
  const dir = await mkdtemp(path.join(tmpdir(), "visuals-digest-"));
  await cp(path.join(root, "dist"), path.join(dir, "dist"), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  scratchDirectories.push(dir);
  await change(dir, manifest);
  await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
  return { dir };
}
const scratchDirectories: string[] = [];
test.after(() =>
  Promise.all(
    scratchDirectories.map((dir) => rm(dir, { recursive: true, force: true })),
  ),
);

test("a dependency pin that no dist file imports leaves the executed identity unchanged (and moves only the legacy fingerprint)", async () => {
  const built = await current();
  const scratch = await copy((_, manifest) => {
    manifest.dependencies["@course-core/sdk"] =
      "https://github.com/roeehrl/course-sdk/releases/download/v9.9.9/course-core-sdk-9.9.9.tgz";
  });
  const changed = await distDigests(scratch.dir);
  assert.equal(changed.executed, built.executed);
  assert.equal(changed.headlessExecuted, built.headlessExecuted);
  assert.deepEqual(changed.files, built.files);
  assert.notEqual(changed.integrity, built.integrity);
  assert.notEqual(changed.headless, built.headless);
  // The recorded legacy fingerprint is still provable from the unchanged bytes.
  const released = record.versions[built.version]!;
  assert.equal(
    (
      await legacyDigests(
        path.join(scratch.dir, "dist"),
        built.version,
        released.legacyBasis,
      )
    ).integrity,
    released.integrity,
  );
});

test("a changed pin of a package the dist imports at run time changes the executed identity", async () => {
  const built = await current();
  const zod = await copy((_, manifest) => {
    manifest.dependencies.zod = "3.25.75";
  });
  const changed = await distDigests(zod.dir);
  assert.notEqual(changed.executed, built.executed);
  assert.notEqual(changed.headlessExecuted, built.headlessExecuted);

  const react = await copy((_, manifest) => {
    manifest.peerDependencies.react = "^19.0.0";
  });
  const peer = await distDigests(react.dir);
  assert.notEqual(peer.executed, built.executed);
  // The headless closure never imports React.
  assert.equal(peer.headlessExecuted, built.headlessExecuted);
});

test("a tampered dist file changes the executed identity and can no longer reproduce the recorded fingerprint", async () => {
  const built = await current();
  const released = record.versions[built.version]!;
  const headless = await copy((dir) =>
    appendFile(path.join(dir, "dist", "runtime.js"), "\n"),
  );
  const changed = await distDigests(headless.dir);
  assert.notEqual(changed.files["runtime.js"], built.files["runtime.js"]);
  assert.notEqual(changed.executed, built.executed);
  assert.notEqual(changed.headlessExecuted, built.headlessExecuted);
  assert.notEqual(
    (
      await legacyDigests(
        path.join(headless.dir, "dist"),
        built.version,
        released.legacyBasis,
      )
    ).integrity,
    released.integrity,
  );

  const client = await copy((dir) =>
    appendFile(path.join(dir, "dist", "react.js"), "\n"),
  );
  const clientChanged = await distDigests(client.dir);
  assert.notEqual(clientChanged.executed, built.executed);
  assert.equal(clientChanged.headlessExecuted, built.headlessExecuted);

  const added = await copy((dir) =>
    writeFile(path.join(dir, "dist", "extra.js"), "export {};\n"),
  );
  assert.notEqual((await distDigests(added.dir)).executed, built.executed);
});

test("manifest fields that decide which file loads are part of the executed identity", async () => {
  const built = await current();
  const exports = await copy((_, manifest) => {
    manifest.exports["./headless"].import = "./dist/index.js";
  });
  const changed = await distDigests(exports.dir);
  assert.notEqual(changed.executed, built.executed);
  assert.notEqual(changed.headlessExecuted, built.headlessExecuted);
  const type = await copy((_, manifest) => {
    manifest.type = "commonjs";
  });
  assert.notEqual(
    (await distDigests(type.dir)).headlessExecuted,
    built.headlessExecuted,
  );
});

test("loading the scanner cannot follow refuses the build instead of under-hashing it", async () => {
  for (const [label, source] of [
    ["dynamic import", 'export const x = () => import("zod");\n'],
    ["require", 'export const x = require("zod");\n'],
    ["undeclared package", 'import "left-pad";\n'],
    ["URL specifier", 'import "https://example.com/x.js";\n'],
    ["relative import outside the hashed files", 'import "../x.js";\n'],
    [
      "comment between from and its specifier",
      'export * from /* x */ "zod";\n',
    ],
  ] as const) {
    const scratch = await copy((dir) =>
      appendFile(path.join(dir, "dist", "runtime.js"), `\n${source}`),
    );
    await assert.rejects(
      distDigests(scratch.dir),
      UnanalysableBuildError,
      label,
    );
  }
  const css = await copy((dir) =>
    appendFile(path.join(dir, "dist", "styles.css"), '\n@import "x.css";\n'),
  );
  await assert.rejects(distDigests(css.dir), UnanalysableBuildError);
});

test("a declared package named anywhere as a quoted specifier is bound, even outside an import statement", async () => {
  const built = await current();
  const mention = await copy(async (dir, manifest) => {
    await appendFile(
      path.join(dir, "dist", "headless.js"),
      '\nexport const sdkEntry = "@course-core/sdk/compiler";\n',
    );
    manifest.dependencies["@course-core/sdk"] = "1.0.0";
  });
  const bound = await distDigests(mention.dir);
  assert.deepEqual(bound.headlessRuntime["@course-core/sdk"], {
    dependency: "1.0.0",
  });
  const repinned = await copy(async (dir, manifest) => {
    await appendFile(
      path.join(dir, "dist", "headless.js"),
      '\nexport const sdkEntry = "@course-core/sdk/compiler";\n',
    );
    manifest.dependencies["@course-core/sdk"] = "2.0.0";
  });
  assert.notEqual(
    (await distDigests(repinned.dir)).headlessExecuted,
    bound.headlessExecuted,
  );
  assert.notEqual(bound.headlessExecuted, built.headlessExecuted);
});
