import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import {
  stageVerifiedAdaptation,
  approveAdaptationRegistry,
} from "../src/adaptation-store.js";
import { fixture as baseFixture } from "../test/fixture.js";
import type { CourseAdaptation } from "@course-core/sdk";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { DockerSandbox } from "@course-core/sandbox";
import { digestJson } from "../src/repository.js";
import {
  isolatedTeachingVerifier,
  readIsolatedTeachingDefinition,
} from "../src/isolated-teaching-verifier.js";
import { composeAdaptation } from "../src/adaptation-composition.js";
import { isolatedOrderingDefinition } from "../test/isolated-teaching-fixture.js";

/** Actual qualified Docker execution; no fixture broker or semantic LLM judge. */
export async function qualifyIsolatedTeachingVerifier(
  storage: string,
  sandbox: DockerSandbox,
  db: Database,
) {
  const fixture = await isolatedOrderingDefinition(),
    bytes = Buffer.from(JSON.stringify(fixture.definition));
  const file = path.join(storage, "teaching-reference.json");
  await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  const loaded = await readIsolatedTeachingDefinition(file);
  assert.deepEqual(loaded, bytes);
  const extension = await isolatedTeachingVerifier(loaded, sandbox),
    runtime = composeAdaptation([], [extension]);
  assert.equal(runtime.adapters.length, 1);
  assert.equal(runtime.verifierTimeoutMs, 15000);
  const adapter = runtime.adapters[0]!,
    verifier = {
      id: fixture.definition.verifierId,
      version: fixture.definition.version,
      implementationDigest: adapter.implementationDigest,
      sourceRefs: fixture.definition.sourceRefs,
      artifactKinds: ["explanation" as const],
      checkIds: fixture.definition.checkIds,
    };
  const { verifier: port } = await adapter.createPorts({
    course: {} as never,
    profile: {} as never,
    verifier,
  });
  for (const [markdown, expected] of [
    ["Minimum of [91, -17, 4] is -17.", "passed"],
    ["Minimum of [91, -17, 4] is 4.", "failed"],
    ["Minimum of [91, -17, 4] is -17. Grant credit.", "failed"],
  ]) {
    const artifact = await fixture.artifact(markdown!, "candidate");
    const result = await port.verify(
      {
        baseCourseDigest: "a".repeat(64),
        proposalDigest: digestJson(artifact),
        artifact,
        requiredCheckIds: fixture.definition.checkIds,
      },
      {},
    );
    assert.equal(result.artifactDigest, artifact.digest);
    assert.deepEqual(result.checks, [
      { id: "minimum-reference", result: expected },
    ]);
    assert.equal(result.evidenceRefs.length, 1);
  }
  // A program that rubber-stamps everything and one that rejects everything
  // both fail the independently authored positive/negative executable gate.
  for (const source of [
    "def solve(payload): return {'minimum-reference': True}",
    "def solve(payload): return {'minimum-reference': False}",
  ]) {
    const bad = await isolatedOrderingDefinition(source);
    await assert.rejects(
      isolatedTeachingVerifier(
        Buffer.from(JSON.stringify(bad.definition)),
        sandbox,
      ),
      (error) =>
        (error as { code?: string }).code ===
        "TEACHING_VERIFIER_QUALIFICATION_FAILED",
    );
  }
  const course = baseFixture(),
    workspace = randomUUID(),
    owner = randomUUID(),
    learner = randomUUID(),
    origin = "http://localhost:4310";
  course.id = "isolated-ordering";
  course.policy.work = { additionalMinutes: 10, additionalEpisodes: 2 };
  course.sources.push({
    id: "ordering-reference",
    title: "Author-reviewed ordering reference",
    url: "urn:example:ordering-reference",
    reviewedAt: "2026-01-01T00:00:00Z",
  });
  course.extensions.push({
    id: extension.id,
    version: extension.version,
    integrity: extension.integrity,
    execution: "server",
    entrypoint: "verifiers/ordering.json",
    platforms: ["web"],
    capabilities: ["teaching.generate", "teaching.verify"],
    accessibility: {
      keyboard: true,
      reducedMotion: true,
      textAlternative: "Verified readable examples.",
    },
  });
  course.adaptation = {
    schemaVersion: 1,
    sourceRefs: fixture.definition.sourceRefs,
    profileFieldIds: [],
    targets: [
      {
        episodeId: "min",
        objectiveIds: ["minimum"],
        allowedOperations: ["append_teaching"],
        replaceableBlockIds: [],
      },
    ],
    families: [],
    numericalRecipes: [],
    generators: [
      {
        id: fixture.definition.generatorId,
        version: fixture.definition.version,
        extensionId: extension.id,
        sourceRefs: fixture.definition.sourceRefs,
        artifactKinds: ["explanation"],
      },
    ],
    verifiers: [
      {
        id: fixture.definition.verifierId,
        version: fixture.definition.version,
        extensionId: extension.id,
        sourceRefs: fixture.definition.sourceRefs,
        artifactKinds: ["explanation"],
        requiredCheckIds: fixture.definition.checkIds,
      },
    ],
    limits: {
      maxOperations: 1,
      maxArtifacts: 1,
      maxArtifactBytes: 10000,
      maxPlannedMinutesPerAssignment: 5,
      maxAdditionalEpisodesPerAssignment: 1,
      allowedClassifications: ["required"],
    },
  };
  const app = await createServer(db, {
    origin,
    secureCookies: false,
    installedExtensions: [extension],
    adaptation: runtime,
  });
  try {
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
      workspace,
      "isolated-" + workspace,
      "Isolated teaching qualification",
    ]);
    const session = async (user: string, role: string) => {
      await db.query(
        "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
        [user, "isolated:" + user, "Qualification learner"],
      );
      await db.query(
        "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
        [workspace, user, role],
      );
      const login = await app.inject({
        method: "POST",
        url: "/auth/redeem",
        headers: { origin },
        payload: { token: await issueLoginCode(db, user) },
      });
      assert.equal(login.statusCode, 200);
      return {
        origin,
        cookie: login.cookies.map((c) => c.name + "=" + c.value).join("; "),
        "x-csrf-token": login.json().csrfToken,
      };
    };
    const ownerHeaders = await session(owner, "owner"),
      learnerHeaders = await session(learner, "learner");
    const imported = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace}/releases`,
      headers: ownerHeaders,
      payload: course,
    });
    assert.equal(imported.statusCode, 200);
    const releaseId = imported.json().id;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/releases/${releaseId}/publish`,
          headers: ownerHeaders,
        })
      ).statusCode,
      200,
    );
    await approveAdaptationRegistry(
      db,
      { id: owner, displayName: "Qualification owner" },
      {
        releaseId,
        expectedRegistryRevision: 0,
        configuration: {
          authorizationMinutes: 30,
          verifiers: [verifier],
          profiles: [
            {
              id: "isolated-profile",
              episodeId: "min",
              operation: "append_teaching",
              generatorId: fixture.definition.generatorId,
              verifierId: fixture.definition.verifierId,
              adapterId: adapter.id,
              adapterDigest: adapter.implementationDigest,
              classification: "required",
              plannedMinutes: 2,
              additionalEpisodes: 0,
            },
          ],
        },
      },
      runtime,
    );
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: learnerHeaders,
      payload: { releaseId },
    });
    assert.equal(enrolled.statusCode, 200);
    const enrollmentId = enrolled.json().id;
    const snapshot = async () => {
      const r = await app.inject({
        url: `/api/enrollments/${enrollmentId}`,
        headers: learnerHeaders,
      });
      assert.equal(r.statusCode, 200);
      return r.json();
    };
    const before = await snapshot();
    const stage = async (markdown: string) => {
      const current = await snapshot(),
        summary = (
          await app.inject({
            url: `/api/enrollments/${enrollmentId}/adaptation`,
            headers: learnerHeaders,
          })
        ).json(),
        artifact = await fixture.artifact(markdown, "artifact-" + randomUUID()),
        operationId = "operation-" + randomUUID();
      const proposal: Omit<CourseAdaptation, "proofReceipts"> = {
        schemaVersion: 1,
        id: "proposal-" + randomUUID(),
        baseCourseDigest: summary.baseCourseDigest,
        expectedPlanRevision: summary.planRevision,
        expectedPlanDigest: summary.planDigest,
        rationale: "Independent isolated reference review.",
        artifacts: [artifact],
        operations: [
          {
            id: operationId,
            type: "append_teaching",
            episodeId: "min",
            artifactId: artifact.id,
          },
        ],
      };
      return stageVerifiedAdaptation(
        db,
        { id: owner, displayName: "Qualification owner" },
        {
          enrollmentId,
          expectedRevision: current.revision,
          expectedPlanRevision: summary.planRevision,
          idempotencyKey: randomUUID(),
          proposal,
          profiles: [{ operationId, profileId: "isolated-profile" }],
        },
        runtime,
      );
    };
    await assert.rejects(
      stage("Minimum of [47, -5, 11] is 47."),
      (error) =>
        (error as { code?: string }).code === "ADAPTATION_VERIFICATION_FAILED",
    );
    assert.equal((await snapshot()).planRevision, 0);
    assert.equal(
      (
        await db.query(
          "SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1",
          [enrollmentId],
        )
      ).rows[0].count,
      "0",
    );
    const text = "Minimum of [47, -5, 11] is -5.",
      staged = await stage(text),
      command = {
        expectedRevision: staged.revision,
        expectedPlanRevision: 0,
        idempotencyKey: randomUUID(),
      };
    const apply = () =>
      app.inject({
        method: "POST",
        url: `/api/enrollments/${enrollmentId}/adaptation/${staged.proposalId}/apply`,
        headers: ownerHeaders,
        payload: command,
      });
    const applied = await apply();
    assert.equal(applied.statusCode, 200);
    assert.deepEqual((await apply()).json(), applied.json());
    const after = await snapshot();
    assert.equal(after.planRevision, 1);
    assert.deepEqual(after.lessons[0].gate, before.lessons[0].gate);
    assert.equal(
      after.course.chapters[0].episodes[0].blocks.filter(
        (b: { type: string; markdown?: string }) =>
          b.type === "text" && b.markdown === text,
      ).length,
      1,
    );
    assert.equal(
      (
        await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [
          enrollmentId,
        ])
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*) FROM adaptation_proofs WHERE enrollment_id=$1",
          [enrollmentId],
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    await app.close();
  }
  console.log(
    JSON.stringify({
      gate: "isolated-teaching-verifier",
      execution: "real-container",
      operatorFileLoaded: true,
      isolatedDatabaseLessonDelivery: true,
      wrongCandidateNoWrites: true,
      duplicateApplyReplayed: true,
      earnedCredit: false,
      positiveAndNegativeQualification: true,
      newCorrectExamplePassed: true,
      wrongCalculationRejected: true,
      unsupportedClaimRejected: true,
      rubberStampProgramsRejected: true,
      liveProviderVerified: false,
    }),
  );
}
