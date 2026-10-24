import { it, expect } from "vitest";
import { digestTeachingArtifact } from "@course-core/sdk";
import { mkdtemp, writeFile, chmod, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DockerSandbox } from "@course-core/sandbox";
import {
  isolatedTeachingVerifier,
  readIsolatedTeachingDefinition,
} from "../src/isolated-teaching-verifier.js";
import { isolatedOrderingDefinition } from "./isolated-teaching-fixture.js";
import { composeAdaptation } from "../src/adaptation-composition.js";

const unreachable = {
  readiness: async () => {
    throw Error("Must reject invalid bundle before using broker");
  },
} as unknown as DockerSandbox;
it("does not turn claimed capability or a malformed/one-sided qualification set into an installed verifier", async () => {
  const { definition } = await isolatedOrderingDefinition();
  const first = definition.qualification[0]!,
    renamed = { ...first.artifact, id: "renamed-example" };
  renamed.digest = await digestTeachingArtifact(renamed);
  for (const change of [
    { version: "1.0.0\n" },
    {
      qualification: [
        ...definition.qualification,
        { ...first, id: "renamed-case", artifact: renamed },
      ],
    },
    { qualification: definition.qualification.slice(0, 2) },
    {
      qualification: definition.qualification.map((q) => ({
        ...q,
        expectedChecks: { "minimum-reference": true },
      })),
    },
    {
      qualification: [
        ...definition.qualification.slice(0, 4),
        definition.qualification[0],
      ],
    },
    {
      qualification: definition.qualification.map((q) => ({
        ...q,
        expectedChecks: { unregistered: true },
      })),
    },
    {
      qualification: definition.qualification.map((q) => ({
        ...q,
        artifact: { ...q.artifact, digest: "f".repeat(64) },
      })),
    },
    { source: "x".repeat(64001) },
    { paidPermission: true },
    { referenceData: "x".repeat(32769) },
  ])
    await expect(
      isolatedTeachingVerifier(
        Buffer.from(JSON.stringify({ ...definition, ...change })),
        unreachable,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /^(INVALID_TEACHING_VERIFIER|TEACHING_(?:QUALIFICATION|VERIFIER)_[A-Z_]+|DUPLICATE_TEACHING_QUALIFICATION)$/,
      ),
    });
});
it("an unavailable or failing broker never installs executable teaching capability", async () => {
  const { definition } = await isolatedOrderingDefinition(),
    bytes = Buffer.from(JSON.stringify(definition));
  await expect(
    isolatedTeachingVerifier(bytes, {
      readiness: async () => ({ ready: false }),
    } as unknown as DockerSandbox),
  ).rejects.toMatchObject({ code: "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE" });
  await expect(
    isolatedTeachingVerifier(bytes, {
      readiness: async () => ({ ready: true }),
      grade: async () => ({ status: "graded", passed: false }),
    } as unknown as DockerSandbox),
  ).rejects.toMatchObject({ code: "TEACHING_VERIFIER_QUALIFICATION_FAILED" });
  // A slow or busy Docker is reported as such (retryable), never as a pass or a failed verifier.
  for (const [status, code] of [["timeout", "TEACHING_VERIFIER_QUALIFICATION_TIMEOUT"], ["busy", "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE"],
    ["unavailable", "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE"], ["output_limit", "TEACHING_VERIFIER_QUALIFICATION_FAILED"]] as const)
    await expect(
      isolatedTeachingVerifier(bytes, {
        readiness: async () => ({ ready: true }),
        grade: async () => ({ status, passed: false }),
      } as unknown as DockerSandbox),
    ).rejects.toMatchObject({ code });
  // The isolated reference is trusted only after executable qualification.
  // Unit-double success is not Docker/production acceptance.
  const extension = await isolatedTeachingVerifier(bytes, {
    readiness: async () => ({ ready: true }),
    grade: async () => ({ status: "graded", passed: true }),
  } as unknown as DockerSandbox);
  expect(composeAdaptation([], [extension]).adapters[0]?.kind).toBe(
    "generated-teaching",
  );
  expect(() =>
    composeAdaptation(
      [],
      [{ ...extension, integrity: "sha256-" + "a".repeat(64) }],
    ),
  ).toThrow();
});
it("operator file loading refuses symlinks, aliases, excessive size and permissive ownership modes before reading programs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "course-teaching-files-"));
  try {
    const file = path.join(dir, "definition.json");
    await writeFile(file, "{}", { mode: 0o600 });
    expect((await readIsolatedTeachingDefinition(file)).toString()).toBe("{}");
    await symlink(file, path.join(dir, "symlink.json"));
    await expect(
      readIsolatedTeachingDefinition(path.join(dir, "symlink.json")),
    ).rejects.toThrow();
    await link(file, path.join(dir, "alias.json"));
    await expect(readIsolatedTeachingDefinition(file)).rejects.toThrow();
    await rm(path.join(dir, "alias.json"));
    await chmod(file, 0o644);
    await expect(readIsolatedTeachingDefinition(file)).rejects.toThrow();
    await chmod(file, 0o600);
    await writeFile(file, Buffer.alloc(262145));
    await expect(readIsolatedTeachingDefinition(file)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
