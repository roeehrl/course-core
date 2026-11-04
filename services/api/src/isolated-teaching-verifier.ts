import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import {
  DockerSandbox,
  validateSubmission,
  type Json,
} from "@course-core/sandbox";
import { digestTeachingArtifact } from "@course-core/sdk";
import { generatedTeachingSelectionSchema } from "./generated-teaching.js";
import { requireCondition, ApiError } from "./errors.js";
import { digestJson } from "./repository.js";
import type { TrustedAdaptationAdapter } from "./adaptation-store.js";
import type { RuntimeExtension } from "./publication.js";
import { failureCode, untilReady, type StartupRetry } from "./startup.js";

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/);
const ids = z
  .array(id)
  .min(1)
  .max(16)
  .refine((v) => new Set(v).size === v.length);
const definitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  adapterId: id,
  generatorId: id,
  verifierId: id,
  version: z.string().regex(/^\d+\.\d+\.\d+$(?![\s\S])/),
  artifactKinds: z
    .array(z.enum(["explanation", "practice", "episode", "visual", "assessment_variant"]))
    .min(1)
    .max(5)
    .refine((v) => new Set(v).size === v.length),
  sourceRefs: ids,
  checkIds: ids,
  source: z.string().min(1).max(64000),
  referenceData: z.unknown(),
  qualification: z
    .array(
      z.strictObject({
        id,
        artifact: generatedTeachingSelectionSchema.shape.artifact,
        expectedChecks: z.record(id, z.boolean()),
      }),
    )
    .min(4)
    .max(16),
});

/** Operator-owned files only. There is no browser/module-import endpoint. */
export async function readIsolatedTeachingDefinition(
  file: string,
): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    requireCondition(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size <= 262144 &&
        (stat.mode & 0o077) === 0 &&
        stat.uid === process.getuid?.(),
      "TEACHING_VERIFIER_FILE_REJECTED",
    );
    const bytes = Buffer.alloc(stat.size + 1),
      { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    requireCondition(bytesRead === stat.size, "TEACHING_VERIFIER_FILE_CHANGED");
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Course-specific verifier programs execute only in the same networkless,
 * read-only, memory/CPU/output/time bounded broker used for practical exercises.
 * Qualification is executable evidence, not a universal factual-validity claim. */
export async function isolatedTeachingVerifier(
  bytes: Buffer,
  sandbox: DockerSandbox,
): Promise<RuntimeExtension> {
  requireCondition(bytes.length <= 262144, "TEACHING_VERIFIER_ENVELOPE");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_TEACHING_VERIFIER");
  }
  const parsed = definitionSchema.safeParse(value);
  requireCondition(parsed.success, "INVALID_TEACHING_VERIFIER");
  const config = parsed.data,
    digest = createHash("sha256").update(bytes).digest("hex"),
    integrity = "sha256-" + digest;
  requireCondition(
    Buffer.byteLength(config.source) <= 64000 &&
      Buffer.byteLength(JSON.stringify(config.referenceData) ?? "") <= 32768,
    "TEACHING_VERIFIER_ENVELOPE",
  );
  const inputs = new Set<string>(),
    caseIds = new Set<string>();
  let positives = 0,
    negatives = 0;
  for (const q of config.qualification) {
    requireCondition(!caseIds.has(q.id), "DUPLICATE_TEACHING_QUALIFICATION");
    caseIds.add(q.id);
    requireCondition(
      q.artifact.generator.id === config.generatorId &&
        q.artifact.generator.version === config.version &&
        config.artifactKinds.includes(q.artifact.kind) &&
        q.artifact.sourceRefs.every((s) => config.sourceRefs.includes(s)) &&
        q.artifact.digest === (await digestTeachingArtifact(q.artifact)),
      "TEACHING_QUALIFICATION_BINDING",
    );
    requireCondition(
      digestJson(Object.keys(q.expectedChecks).sort()) ===
        digestJson([...config.checkIds].sort()),
      "TEACHING_QUALIFICATION_CHECKS",
    );
    const {
      id: _artifactId,
      digest: _artifactDigest,
      ...semanticArtifact
    } = q.artifact;
    const inputDigest = digestJson(semanticArtifact);
    requireCondition(
      !inputs.has(inputDigest),
      "DUPLICATE_TEACHING_QUALIFICATION",
    );
    inputs.add(inputDigest);
    if (Object.values(q.expectedChecks).every(Boolean)) positives++;
    else negatives++;
  }
  requireCondition(
    positives >= 2 && negatives >= 2,
    "TEACHING_QUALIFICATION_COVERAGE",
  );
  const payload = (
    artifact: unknown,
    baseCourseDigest = "a".repeat(64),
    proposalDigest = "b".repeat(64),
  ) =>
    ({
      artifact,
      referenceData: structuredClone(config.referenceData),
      requiredCheckIds: [...config.checkIds],
      baseCourseDigest,
      proposalDigest,
    }) as Json;
  const cases = config.qualification.map((q) => ({
    id: q.id,
    input: payload(q.artifact),
    expected: q.expectedChecks,
  }));
  try {
    validateSubmission({ source: config.source, cases });
  } catch {
    throw new ApiError(400, "TEACHING_VERIFIER_ENVELOPE");
  }
  // A broker that could not confirm a container was removed quarantines itself for the life of
  // the process and keeps broker.lock (packages/sandbox): it refuses every later run without
  // calling Docker, so that is QUARANTINED, which no retry can fix. A broker.lock this process
  // did not leave may belong to another broker on the same directory (LOCKED, retryable).
  const readiness = await sandbox.readiness();
  requireCondition(
    readiness.ready,
    readiness.reason === "cleanup_required"
      ? "TEACHING_VERIFIER_SANDBOX_QUARANTINED"
      : readiness.reason === "broker_locked"
        ? "TEACHING_VERIFIER_SANDBOX_LOCKED"
        : "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE",
    503,
  );
  const qualification = await sandbox.grade({ source: config.source, cases });
  // A sandbox that could not run the cases (busy, unavailable, too slow to start, a cleanup
  // failure) or ran out of time says nothing about the verifier: those are 503s. Busy,
  // unavailable and too slow are retried at startup within a deadline; a cleanup failure has
  // quarantined the broker and is not. Only cases that ran and did not all pass, or broke the
  // output protocol, are a failed qualification. Either way nothing is installed.
  requireCondition(
    qualification.status !== "cleanup_failed",
    "TEACHING_VERIFIER_SANDBOX_QUARANTINED",
    503,
  );
  requireCondition(
    !["busy", "unavailable", "setup_timeout"].includes(qualification.status),
    "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE",
    503,
  );
  requireCondition(
    qualification.status !== "timeout",
    "TEACHING_VERIFIER_QUALIFICATION_TIMEOUT",
    503,
  );
  requireCondition(
    qualification.status === "graded" && qualification.passed,
    "TEACHING_VERIFIER_QUALIFICATION_FAILED",
    409,
  );
  const adapter: TrustedAdaptationAdapter = {
    id: config.adapterId,
    kind: "generated-teaching",
    implementationDigest: digest,
    validateProfile(course, profile) {
      const generator = course.adaptation?.generators.find(
          (g) => g.id === profile.generatorId,
        ),
        verifier = course.adaptation?.verifiers.find(
          (v) => v.id === profile.verifierId,
        );
      requireCondition(
        profile.generatorId === config.generatorId &&
          profile.verifierId === config.verifierId &&
          generator?.extensionId === config.id &&
          verifier?.extensionId === config.id &&
          generator.version === config.version &&
          verifier.version === config.version &&
          digestJson([...verifier.requiredCheckIds].sort()) ===
            digestJson([...config.checkIds].sort()) &&
          digestJson([...verifier.sourceRefs].sort()) ===
            digestJson([...config.sourceRefs].sort()) &&
          generator.sourceRefs.every((s) => config.sourceRefs.includes(s)) &&
          generator.artifactKinds.every((k) =>
            config.artifactKinds.includes(k as (typeof config.artifactKinds)[number]),
          ) &&
          verifier.artifactKinds.every((k) =>
            config.artifactKinds.includes(k as (typeof config.artifactKinds)[number]),
          ),
        "TEACHING_VERIFIER_PROFILE_BINDING",
        409,
      );
    },
    async createPorts({ verifier }) {
      return {
        verifier: {
          registration: verifier,
          async verify(input, options) {
            requireCondition(
              input.artifact.digest ===
                (await digestTeachingArtifact(input.artifact)) &&
                input.artifact.generator.id === config.generatorId &&
                input.artifact.generator.version === config.version &&
                config.artifactKinds.includes(
                  input.artifact.kind as (typeof config.artifactKinds)[number],
                ) &&
                input.artifact.sourceRefs.every((s) =>
                  config.sourceRefs.includes(s),
                ) &&
                digestJson([...input.requiredCheckIds].sort()) ===
                  digestJson([...config.checkIds].sort()),
              "TEACHING_VERIFIER_INPUT_BINDING",
              409,
            );
            const report = await sandbox.grade({
              source: config.source,
              cases: [
                {
                  id: "candidate",
                  input: payload(
                    input.artifact,
                    input.baseCourseDigest,
                    input.proposalDigest,
                  ),
                  expected: Object.fromEntries(
                    config.checkIds.map((id) => [id, true]),
                  ),
                },
              ],
              ...(options.signal ? { signal: options.signal } : {}),
            });
            if (
              ["busy", "unavailable", "cleanup_failed", "setup_timeout"].includes(report.status)
            )
              throw new ApiError(503, "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE");
            const passed = report.status === "graded" && report.passed;
            return {
              artifactDigest: input.artifact.digest,
              checks: config.checkIds.map((id) => ({
                id,
                result: passed ? ("passed" as const) : ("failed" as const),
              })),
              evidenceRefs: [
                "isolated-review:" +
                  digestJson({
                    definitionDigest: digest,
                    artifactDigest: input.artifact.digest,
                    sourceDigest: report.sourceDigest,
                    runtime: report.runtime,
                    status: report.status,
                    passed,
                  }),
              ],
            };
          },
        },
      };
    },
  };
  return {
    id: config.id,
    version: config.version,
    integrity,
    platforms: ["web"],
    capabilities: ["teaching.generate", "teaching.verify"],
    adaptationAdapter: adapter,
  };
}

/** Qualification failures a wait can fix: Docker or the sandbox busy, slow or briefly locked by
 * another broker. TEACHING_VERIFIER_SANDBOX_QUARANTINED is deliberately absent: the broker has
 * disabled itself for this process (packages/sandbox never clears its own lock), so retrying only
 * hides the cause until the deadline. A failed qualification is never retried either. */
export const RETRYABLE_QUALIFICATION_CODES: ReadonlySet<string> = new Set([
  "TEACHING_VERIFIER_SANDBOX_UNAVAILABLE",
  "TEACHING_VERIFIER_SANDBOX_LOCKED",
  "TEACHING_VERIFIER_QUALIFICATION_TIMEOUT",
]);

/** Startup qualification: retries transient sandbox failures until `deadlineMs`, reporting each
 * retry; anything else (a quarantined broker, a failed verifier) is thrown at once. */
export function qualifyIsolatedTeachingVerifier(
  bytes: Buffer,
  sandbox: DockerSandbox,
  options: {
    deadlineMs: number;
    onRetry?: (retry: StartupRetry) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<RuntimeExtension> {
  return untilReady(
    () => isolatedTeachingVerifier(bytes, sandbox),
    (error) => RETRYABLE_QUALIFICATION_CODES.has(failureCode(error)),
    options.deadlineMs,
    {
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    },
  );
}
