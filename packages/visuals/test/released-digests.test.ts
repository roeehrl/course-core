import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distDigests } from "../scripts/dist-digest.js";

interface Released {
  integrity: string;
  headless: string;
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

async function current() {
  await stat(new URL("../dist/headless.js", import.meta.url)).catch(() => {
    throw new Error(
      "Build the package (npm run build) before checking its released digest.",
    );
  });
  return distDigests(root);
}

test("the built dist matches the recorded digest for its version (any byte change needs a version bump)", async () => {
  const built = await current();
  const released = record.versions[built.version];
  assert.ok(
    released,
    `Version ${built.version} has no entry in released-digests.json; record it with npm run digest`,
  );
  assert.equal(
    built.integrity,
    released.integrity,
    `dist differs from the recorded ${built.version} build. Bump packages/visuals version instead of changing released bytes.`,
  );
  assert.equal(built.headless, released.headless);
  assert.deepEqual(built.headlessFiles, released.headlessFiles);
});

test("the current version is the newest recorded release and distinct versions never share a fingerprint", async () => {
  const built = await current();
  const versions = Object.keys(record.versions);
  const newest = [...versions]
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  assert.equal(built.version, newest);
  const integrities = Object.values(record.versions).map(
    (entry) => entry.integrity,
  );
  assert.equal(new Set(integrities).size, integrities.length);
  for (const bad of record.mislabeled) {
    assert.notEqual(record.versions[bad.version]?.integrity, bad.integrity);
    assert.ok(!integrities.includes(bad.integrity));
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
  assert.equal(built.headless, prior.headless);
});
