import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { authService, issueLoginCode } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { ensureCatalog, registerAdminRoutes } from "../src/admin-routes.js";
import type { RuntimeExtension } from "../src/publication.js";
import { fixture } from "./fixture.js";
import { createJob } from "@course-core/supervisor";
import { composeProviders, unconfiguredProviders } from "../src/provider-composition.js";
import { AGENT_ROLES } from "../src/provider-runtime.js";

const origin = "http://127.0.0.1:4381";
const schema = `admin_test_${randomUUID().replaceAll("-", "")}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspaceId: string, catalogId: string, releaseId: string;
let admin: Session,
  reviewer: Session,
  observer: Session,
  author: Session,
  outsider: Session;
let installed: RuntimeExtension[] = [];
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function session(
  role: string,
  workspace = workspaceId,
): Promise<Session> {
  const userId = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [userId, `admin-test:${userId}`, `${role} example`],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspace, userId, role],
  );
  const token = await issueLoginCode(db, userId),
    response = await app.inject({
      method: "POST",
      url: "/auth/redeem",
      headers: { origin },
      payload: { token },
    });
  expect(response.statusCode, response.body).toBe(200);
  return {
    userId,
    cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf: response.json().csrfToken,
  };
}
function req(
  who: Session,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: who.cookie,
      origin,
      "x-csrf-token": who.csrf,
      ...headers,
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
const coursePath = () => `/api/admin/courses/${catalogId}`;
async function snapshot(who = admin) {
  const response = await req(who, "GET", coursePath());
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function mutation(
  who: Session,
  method: "POST" | "PATCH",
  suffix: string,
  payload: unknown,
  headers?: Record<string, string>,
) {
  return req(
    who,
    method,
    coursePath() + suffix,
    payload,
    headers ?? {
      "if-match": (await snapshot(who)).revision,
      "idempotency-key": randomUUID(),
    },
  );
}
async function enroll() {
  const learner = await session("learner");
  const response = await req(learner, "POST", "/api/enrollments", {
    releaseId,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { learner, id: response.json().id as string };
}
async function learnerCommand(
  learner: Session,
  id: string,
  action: string,
  data: object,
) {
  const current = await req(learner, "GET", `/api/enrollments/${id}`);
  return req(learner, "POST", `/api/enrollments/${id}/${action}`, {
    expectedRevision: current.json().revision,
    idempotencyKey: randomUUID(),
    ...data,
  });
}
async function grade(
  learner: Session,
  id: string,
  assessmentId: string,
  answer: string | number,
  assisted = false,
) {
  const issued = await learnerCommand(learner, id, "challenges", {
    episodeId: "min",
    assessmentId,
    mode: "independent",
  });
  expect(issued.statusCode, issued.body).toBe(200);
  if (assisted)
    expect(
      (
        await learnerCommand(learner, id, "solution", {
          challengeId: issued.json().challengeId,
        })
      ).statusCode,
    ).toBe(200);
  const response = await learnerCommand(learner, id, "answers", {
    challengeId: issued.json().challengeId,
    answer,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (
    await db.query(
      "SELECT e.id FROM evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.enrollment_id=$1 AND a.assessment_id=$2 ORDER BY e.created_at DESC",
      [id, assessmentId],
    )
  ).rows[0].id as string;
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providerCredential = randomBytes(32).toString("base64url");
  const providers = composeProviders(
    {
      registry: {
        revision: "admin-test",
        models: [
          {
            id: "configured-model",
            providerId: "trusted-provider",
            remoteModel: "test-model",
            enabled: true,
            capabilities: ["tutoring"],
            tools: [],
            providerConfig: {},
            limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 },
          },
        ],
      },
      adapters: [
        {
          id: "trusted-provider",
          kind: "test-only",
          credentialEnv: "COURSE_PROVIDER_TEST_API_KEY",
        },
      ],
      roles: {
        companion: {
          modelId: "configured-model",
          maxInputCharacters: 5000,
          maxOutputTokens: 100,
        },
      },
    },
    () => providerCredential,
    {
      "test-only": () => ({
        providerId: "trusted-provider",
        validateModel: () => {},
        ports: {
          tutoring: {
            async tutor() {
              throw new Error("Admin tests must not execute a provider.");
            },
          },
        },
      }),
    },
  );
  expect(
    JSON.stringify(providers.describe()).includes(providerCredential),
  ).toBe(false);
  app = await createServer(db, { loginCodes: true,
    origin,
    secureCookies: false,
    installedExtensions: installed,
    providers,
  });
  expect(app.hasRoute({ method: "GET", url: "/api/admin/session" })).toBe(true);
  workspaceId = randomUUID();
  const foreign = randomUUID();
  await db.query(
    "INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3),($4,$5,$6)",
    [
      workspaceId,
      "admin-test",
      "Admin test",
      foreign,
      "admin-foreign",
      "Foreign",
    ],
  );
  admin = await session("admin");
  reviewer = await session("reviewer");
  observer = await session("observer");
  author = await session("author");
  outsider = await session("admin", foreign);
  releaseId = randomUUID();
  const compiled = compileCourse(fixture());
  await db.query(
    "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [
      releaseId,
      workspaceId,
      compiled.server.id,
      compiled.server.version,
      compiled.digest,
      JSON.stringify(compiled.server),
      JSON.stringify(compiled.learner),
      admin.userId,
    ],
  );
  catalogId = await ensureCatalog(db, releaseId);
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("real admin access and catalog", () => {
  it("requires the scoped cookie session, origin and CSRF", async () => {
    expect((await app.inject({ url: "/api/admin/session" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: coursePath(),
          headers: {
            cookie: admin.cookie,
            origin,
            "if-match": "1",
            "idempotency-key": randomUUID(),
          },
          payload: { title: "Changed", description: "" },
        })
      ).json().error,
    ).toBe("CSRF_REJECTED");
    expect(
      (
        await req(
          admin,
          "PATCH",
          coursePath(),
          { title: "Changed", description: "" },
          {
            origin: "https://wrong.invalid",
            "if-match": "1",
            "idempotency-key": randomUUID(),
          },
        )
      ).json().error,
    ).toBe("ORIGIN_REJECTED");
    expect((await req(outsider, "GET", coursePath())).statusCode).toBe(403);
    expect(
      (await req(outsider, "GET", "/api/admin/session")).json().courses,
    ).toHaveLength(0);
    expect(
      (await req(await session("learner"), "GET", coursePath())).statusCode,
    ).toBe(403);
  });
  it("enforces permission roles and withholds learner data from authors and observers", async () => {
    await enroll();
    for (const who of [observer, author]) {
      const data = await snapshot(who);
      expect(data.enrollments).toEqual([]);
      expect(data.runs).toEqual([]);
    }
    expect(
      (
        await mutation(observer, "PATCH", "", {
          title: "Forbidden",
          description: "",
        })
      ).statusCode,
    ).toBe(403);
    expect((await snapshot(reviewer)).permissions).toContain("evidence.review");
    expect((await snapshot(reviewer)).permissions).not.toContain(
      "course.write",
    );
  });
  it("serializes idempotent writes in PostgreSQL and rejects stale or changed requests", async () => {
    const before = await snapshot(),
      headers = {
        "if-match": before.revision,
        "idempotency-key": randomUUID(),
      },
      input = {
        title: "Ordering catalog",
        description: "Stored in PostgreSQL.",
      };
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        req(admin, "PATCH", coursePath(), input, headers),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM admin_command_receipts WHERE catalog_id=$1 AND idempotency_key=$2",
          [catalogId, headers["idempotency-key"]],
        )
      ).rows[0].count,
    ).toBe("1");
    expect(
      (
        await req(
          admin,
          "PATCH",
          coursePath(),
          { ...input, title: "Different" },
          headers,
        )
      ).json().error,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      (
        await req(admin, "PATCH", coursePath(), input, {
          ...headers,
          "idempotency-key": randomUUID(),
        })
      ).json().error,
    ).toBe("STALE_REVISION");
  });
  it("rolls back metadata and receipts if the audit event cannot commit", async () => {
    const before = await snapshot();
    await db.query(
      `CREATE FUNCTION admin_test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='admin.course.updated' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      "CREATE TRIGGER admin_test_reject_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION admin_test_reject_event()",
    );
    const headers = {
      "if-match": before.revision,
      "idempotency-key": randomUUID(),
    };
    try {
      expect(
        (
          await req(
            admin,
            "PATCH",
            coursePath(),
            { title: "Must rollback", description: "" },
            headers,
          )
        ).statusCode,
      ).toBe(500);
      expect((await snapshot()).revision).toBe(before.revision);
      expect((await snapshot()).course.title).toBe(before.course.title);
    } finally {
      await db.query("DROP TRIGGER admin_test_reject_event ON learning_events");
      await db.query("DROP FUNCTION admin_test_reject_event()");
    }
    expect(
      (
        await req(
          admin,
          "PATCH",
          coursePath(),
          { title: "Committed retry", description: "" },
          headers,
        )
      ).statusCode,
    ).toBe(200);
  });
});
describe("real immutable release lifecycle", () => {
  it("validates drafts, reviews exact digests and publishes without changing existing releases", async () => {
    const created = await mutation(author, "POST", "/releases", {
      version: "1.1.0",
      notes: "Validated clone.",
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created
      .json()
      .workspace.releases.find((r: any) => r.version === "1.1.0").id;
    expect(
      (
        await mutation(admin, "POST", `/releases/${id}/transitions`, {
          action: "publish",
        })
      ).json().error,
    ).toBe("RELEASE_REVIEW_REQUIRED");
    expect(
      (
        await mutation(author, "POST", `/releases/${id}/transitions`, {
          action: "submit-review",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await mutation(reviewer, "POST", `/releases/${id}/transitions`, {
          action: "approve",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await mutation(admin, "POST", `/releases/${id}/transitions`, {
          action: "publish",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await mutation(admin, "PATCH", `/releases/${id}`, {
          manifest: { ...fixture(), version: "1.1.0" },
          notes: "tamper",
        })
      ).json().error,
    ).toBe("PUBLISHED_RELEASE_IMMUTABLE");
    await expect(
      db.query("UPDATE course_releases SET digest=$2 WHERE id=$1", [
        id,
        "f".repeat(64),
      ]),
    ).rejects.toThrow("PUBLISHED_RELEASE_IMMUTABLE");
  });
  it("rechecks installed handler gates inside publication; metadata cannot make an evaluator real", async () => {
    const manifest = fixture();
    manifest.version = "2.0.0";
    const declaration = {
      id: "grader",
      version: "1.0.0",
      integrity: "sha256-" + "a".repeat(64),
      platforms: ["web" as const],
      execution: "server" as const,
      entrypoint: "grader.js",
      capabilities: ["assessment.evaluate"],
      accessibility: {
        keyboard: true,
        reducedMotion: true,
        textAlternative: "Grading",
      },
    };
    manifest.extensions.push(declaration);
    manifest.assessments[0] = {
      id: "min-a",
      familyId: "compare",
      objectiveIds: ["minimum"],
      type: "rubric",
      prompt: "Explain.",
      grading: {
        evaluatorId: "grader",
        rubric: [{ id: "claim", description: "Ordering", required: true }],
      },
    };
    const created = await mutation(admin, "POST", "/releases", {
      version: "2.0.0",
      notes: "Needs real evaluator.",
      manifest,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created
      .json()
      .workspace.releases.find((r: any) => r.version === "2.0.0").id;
    await db.query(
      "UPDATE admin_release_reviews SET state='approved',reviewed_digest=(SELECT digest FROM course_releases WHERE id=$1) WHERE release_id=$1",
      [id],
    );
    expect(
      (
        await mutation(admin, "POST", `/releases/${id}/transitions`, {
          action: "publish",
        })
      ).json().error,
    ).toBe("PUBLISH_CAPABILITY_MISSING");
    installed.splice(0, installed.length, {
      id: "grader",
      version: "1.0.0",
      integrity: declaration.integrity,
      platforms: ["web"],
      capabilities: ["assessment.evaluate"],
    });
    try {
      expect(
        (
          await mutation(admin, "POST", `/releases/${id}/transitions`, {
            action: "publish",
          })
        ).json().error,
      ).toBe("PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE");
    } finally {
      installed.length = 0;
    }
    expect(
      (await db.query("SELECT status FROM course_releases WHERE id=$1", [id]))
        .rows[0].status,
    ).toBe("draft");
  });
});
describe("real evidence and enrollment administration", () => {
  it("creates only in-workspace enrollments and retains a pinned release", async () => {
    const learner = await session("learner");
    const created = await mutation(admin, "POST", "/enrollments", {
      learnerRef: learner.userId,
      releaseId,
      profile: {
        displayName: "Selected learner",
        goal: "Compare.",
        pace: "steady",
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(
      created
        .json()
        .workspace.enrollments.find((e: any) => e.learnerRef === learner.userId)
        .releaseVersion,
    ).toBe("1.0.0");
    expect(
      (
        await mutation(admin, "POST", "/enrollments", {
          learnerRef: outsider.userId,
          releaseId,
          profile: { displayName: "Wrong workspace", goal: "", pace: "steady" },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("never converts incorrect deterministic or assisted results into earned mastery", async () => {
    for (const assisted of [false, true]) {
      const { learner, id } = await enroll();
      const evidenceId = await grade(
        learner,
        id,
        "min-a",
        assisted ? "two" : "five",
        assisted,
      );
      const e = (await snapshot()).enrollments.find((e: any) => e.id === id);
      const before = (
        await db.query("SELECT result,independent FROM evidence WHERE id=$1", [
          evidenceId,
        ])
      ).rows[0];
      const response = await mutation(
        reviewer,
        "POST",
        `/enrollments/${id}/evidence/${evidenceId}/review`,
        {
          decision: "accept",
          note: "Cannot promote grade.",
          enrollmentRevision: e.revision,
        },
      );
      expect(response.json().error).toBe("REVIEW_CANNOT_GRANT_MASTERY");
      expect(
        (
          await db.query(
            "SELECT result,independent FROM evidence WHERE id=$1",
            [evidenceId],
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT count(*) FROM admin_evidence_reviews WHERE evidence_id=$1",
            [evidenceId],
          )
        ).rows[0].count,
      ).toBe("0");
    }
  });
  it("acknowledges valid evidence, then invalidates with audit and relocks descendants", async () => {
    const { learner, id } = await enroll();
    const evidenceId = await grade(learner, id, "min-a", "two");
    await grade(learner, id, "min-b", 4);
    await learnerCommand(learner, id, "read", {
      episodeId: "min",
      blockId: "min-text",
    });
    expect(
      (await learnerCommand(learner, id, "complete", { episodeId: "min" }))
        .statusCode,
    ).toBe(200);
    let e = (await snapshot()).enrollments.find((e: any) => e.id === id);
    expect(e.lessons[1].status).toBe("available");
    const acknowledged = await mutation(
      reviewer,
      "POST",
      `/enrollments/${id}/evidence/${evidenceId}/review`,
      {
        decision: "accept",
        note: "Verified existing correct independent result.",
        enrollmentRevision: e.revision,
      },
    );
    expect(acknowledged.statusCode, acknowledged.body).toBe(200);
    e = acknowledged.json().workspace.enrollments.find((e: any) => e.id === id);
    expect(e.completed).toBe(1);
    const rejected = await mutation(
      reviewer,
      "POST",
      `/enrollments/${id}/evidence/${evidenceId}/review`,
      {
        decision: "reject",
        note: "Revoked after audit.",
        enrollmentRevision: e.revision,
      },
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(
      rejected.json().workspace.enrollments.find((e: any) => e.id === id)
        .lessons[1].status,
    ).toBe("locked");
    expect(
      (await req(learner, "GET", `/api/enrollments/${id}`)).json().lessons[1]
        .status,
    ).toBe("locked");
    expect(
      (
        await db.query(
          "SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='evidence.invalidated'",
          [id],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("uses enrollment revisions as well as catalog revisions for profile changes", async () => {
    const { learner, id } = await enroll();
    const e = (await snapshot()).enrollments.find((e: any) => e.id === id);
    await learnerCommand(learner, id, "read", {
      episodeId: "min",
      blockId: "min-text",
    });
    expect(
      (
        await mutation(admin, "PATCH", `/enrollments/${id}/profile`, {
          profile: { displayName: "New name", goal: "", pace: "gentle" },
          enrollmentRevision: e.revision,
        })
      ).json().error,
    ).toBe("STALE_REVISION");
  });
});

describe("authoritative calendar offers and preserving migrations", () => {
  async function policy(id: string, who = admin) {
    const response = await req(
      who,
      "GET",
      `/api/admin/enrollments/${id}/policy`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function propose(id: string, days = 1) {
    const current = await policy(id);
    const response = await req(
      admin,
      "POST",
      `/api/admin/enrollments/${id}/extensions/propose`,
      {
        scopeId: "course",
        days,
        rationaleEventIds: [current.rationaleEvents[0].id],
        episodeIds: ["min"],
        planImpact: "One more calendar day for existing work.",
        alternatives: ["Continue with the existing deadline."],
        expectedRevision: current.revision,
        idempotencyKey: randomUUID(),
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  it("uses real domain previews/proposals and cannot accept learner consent or debit automatically", async () => {
    const { learner, id } = await enroll(),
      before = await policy(id);
    const preview = await req(
      admin,
      "POST",
      `/api/admin/enrollments/${id}/extensions/preview`,
      { scopeId: "course", days: 1 },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().balanceBefore[0].remaining).toBe(2);
    expect(preview.json().balanceAfter[0].remaining).toBe(1);
    expect((await policy(id)).balances).toEqual(before.balances);
    const offered = await propose(id),
      offer = offered.policy.offers[0];
    expect(offer.state).toBe("proposed");
    expect(offer.acceptance).toBeUndefined();
    expect(offered.policy.grants).toEqual([]);
    expect(offered.policy.balances).toEqual(before.balances);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/extensions/accept`,
          {
            offerId: offer.terms.offerId,
            termsDigest: offer.termsDigest,
            explicitConsent: true,
          },
        )
      ).statusCode,
    ).toBe(404);
    const accept = {
      offerId: offer.terms.offerId,
      termsDigest: offer.termsDigest,
      explicitConsent: true,
      expectedRevision: offered.policy.revision,
      idempotencyKey: randomUUID(),
    };
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/enrollments/${id}/extensions/accept`,
          accept,
        )
      ).statusCode,
    ).toBe(404);
    const accepted = await req(
      learner,
      "POST",
      `/api/enrollments/${id}/extensions/accept`,
      accept,
    );
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await policy(id)).balances[0].remaining).toBe(1);
    expect(
      (
        await db.query(
          "SELECT count(*) FROM extension_grants WHERE enrollment_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe("1");
  });
  it("requires scoped rationale and activities and respects per-grant caps", async () => {
    const { id } = await enroll(),
      current = await policy(id);
    const base = {
      scopeId: "course",
      days: 1,
      rationaleEventIds: [randomUUID()],
      episodeIds: ["min"],
      planImpact: "A reason",
      alternatives: ["Keep deadline"],
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
    };
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/extensions/propose`,
          base,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/extensions/propose`,
          {
            ...base,
            rationaleEventIds: [current.rationaleEvents[0].id],
            episodeIds: ["not-in-course"],
          },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/extensions/preview`,
          { scopeId: "course", days: 3 },
        )
      ).json().error,
    ).toBe("PER_GRANT_LIMIT");
    expect(
      (await req(observer, "GET", `/api/admin/enrollments/${id}/policy`))
        .statusCode,
    ).toBe(403);
  });
  it("requires an actor-bound impact preview and preserves anchors, pools, grants and balances during migration", async () => {
    const { learner, id } = await enroll(),
      offered = await propose(id),
      offer = offered.policy.offers[0];
    expect(
      (
        await req(learner, "POST", `/api/enrollments/${id}/extensions/accept`, {
          offerId: offer.terms.offerId,
          termsDigest: offer.termsDigest,
          explicitConsent: true,
          expectedRevision: offered.policy.revision,
          idempotencyKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    const before = await policy(id),
      scopes = before.scopes.map(({ label: _label, ...scope }: any) => scope);
    scopes[0].work.additionalMinutes = 240;
    const preview = await req(
      admin,
      "POST",
      `/api/admin/enrollments/${id}/policy/preview`,
      { scopes },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().impacts[0].after.quotas[0].limit).toBe(240);
    const input = {
      previewId: preview.json().previewId,
      previewDigest: preview.json().previewDigest,
      reason: "Bound additional work explicitly.",
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
    };
    const anotherAdmin = await session("admin");
    expect(
      (
        await req(
          anotherAdmin,
          "POST",
          `/api/admin/enrollments/${id}/policy/migrate`,
          input,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/policy/migrate`,
          { ...input, previewDigest: "0".repeat(64) },
        )
      ).statusCode,
    ).toBe(409);
    const applied = await req(
      admin,
      "POST",
      `/api/admin/enrollments/${id}/policy/migrate`,
      input,
    );
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().policy.scopes[0].window).toEqual(
      before.scopes[0].window,
    );
    expect(applied.json().policy.pools).toEqual(before.pools);
    expect(applied.json().policy.grants).toEqual(before.grants);
    expect(applied.json().policy.balances).toEqual(before.balances);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/policy/migrate`,
          input,
        )
      ).body,
    ).toBe(applied.body);
    expect(
      (
        await db.query(
          "SELECT snapshot->'migrations' AS migrations FROM policy_states WHERE enrollment_id=$1",
          [id],
        )
      ).rows[0].migrations[0].authorityReceipt.actorId,
    ).toBe(admin.userId);
    const reset = structuredClone(scopes);
    reset[0].window.anchorInstant = "2020-01-01T00:00:00Z";
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/policy/preview`,
          { scopes: reset },
        )
      ).json().error,
    ).toBe("RESET_FORBIDDEN");
  });
  it("applies an individual accommodation with its own audited authority, leaving pools, grants and other learners unchanged", async () => {
    const { learner, id } = await enroll(),
      other = await enroll(),
      before = await policy(id),
      otherBefore = await policy(other.id),
      course = before.scopes.find((s: any) => s.scopeId === "course");
    const change = { deadline: { kind: course.window ? "window" : "absolute", calendarDays: 5 } };
    expect((await req(learner, "POST", `/api/admin/enrollments/${id}/accommodations/preview`, { scopeId: "course", kind: "accommodation", change })).statusCode).toBe(403);
    // An approved pause may only move a pause-enabled window, never add work.
    const paused = await req(admin, "POST", `/api/admin/enrollments/${id}/accommodations/preview`, { scopeId: "course", kind: "approved_pause", change: { ...change, work: { additionalMinutes: 10 } } });
    expect(paused.json().error, paused.body).toBe("PAUSE_NOT_ALLOWED");
    const preview = await req(admin, "POST", `/api/admin/enrollments/${id}/accommodations/preview`, { scopeId: "course", kind: "accommodation", change });
    expect(preview.statusCode, preview.body).toBe(200);
    const input = { previewId: preview.json().previewId, previewDigest: preview.json().previewDigest, reason: "Approved request ACC-17.", expectedRevision: before.revision, idempotencyKey: randomUUID() };
    // Previews are bound to their kind and their author.
    expect((await req(admin, "POST", `/api/admin/enrollments/${id}/policy/migrate`, input)).json().error).toBe("STALE_PREVIEW");
    expect((await req(await session("admin"), "POST", `/api/admin/enrollments/${id}/accommodations/apply`, input)).json().error).toBe("STALE_PREVIEW");
    const applied = await req(admin, "POST", `/api/admin/enrollments/${id}/accommodations/apply`, input);
    expect(applied.statusCode, applied.body).toBe(200);
    const after = applied.json().policy;
    expect(after.accommodations).toEqual([expect.objectContaining({ kind: "accommodation", scopeId: "course" })]);
    const deadline = (p: any) => p.constraints.find((c: any) => c.scopeId === "course").effectiveDeadline;
    expect(Date.parse(deadline(after)) - Date.parse(deadline(before))).toBe(5 * 86_400_000);
    expect(after.pools).toEqual(before.pools);
    expect(after.balances).toEqual(before.balances);
    expect(after.grants).toEqual(before.grants);
    expect((await req(admin, "POST", `/api/admin/enrollments/${id}/accommodations/apply`, input)).body).toBe(applied.body);
    expect(deadline(await policy(other.id))).toBe(deadline(otherBefore));
    const audit = (await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='policy.accommodation_authorized'", [id])).rows;
    expect(audit).toEqual([{ actor_kind: "staff", payload: expect.objectContaining({ reason: "Approved request ACC-17.", kind: "accommodation" }) }]);
  });
  it("rejects migration after an intervening enrollment revision", async () => {
    const { learner, id } = await enroll(),
      before = await policy(id),
      scopes = before.scopes.map(({ label: _label, ...scope }: any) => scope);
    scopes[0].work.additionalMinutes = 120;
    const preview = await req(
      admin,
      "POST",
      `/api/admin/enrollments/${id}/policy/preview`,
      { scopes },
    );
    expect(preview.statusCode, preview.body).toBe(200);
    await learnerCommand(learner, id, "read", {
      episodeId: "min",
      blockId: "min-text",
    });
    const now = await policy(id);
    expect(
      (
        await req(
          admin,
          "POST",
          `/api/admin/enrollments/${id}/policy/migrate`,
          {
            previewId: preview.json().previewId,
            previewDigest: preview.json().previewDigest,
            reason: "Stale proposal.",
            expectedRevision: now.revision,
            idempotencyKey: randomUUID(),
          },
        )
      ).json().error,
    ).toBe("STALE_PREVIEW");
  });
});
describe("trusted runtime and scoped operational projections", () => {
  it("reports actual runtime configuration separately from verification and stores only metadata requests", async () => {
    const before = await snapshot(),
      provider = before.providers.find((p: any) => p.id === "configured-model");
    expect(provider.configuration).toBe("configured");
    expect(provider.verification).toBe("not_run");
    const response = await mutation(
      admin,
      "POST",
      "/providers/configured-model/configuration-requests",
      { connectionLabel: "Public label", environment: "staging" },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .workspace.providers.find((p: any) => p.id === "configured-model"),
    ).toMatchObject({ configuration: "configured", verification: "not_run" });
    expect(
      (
        await mutation(
          admin,
          "POST",
          "/providers/configured-model/configuration-requests",
          {
            connectionLabel: "Forbidden",
            environment: "staging",
            apiKey: "never-accepted",
          },
        )
      ).statusCode,
    ).toBe(400);
  });
  it("lists a capability slot for every agent role, reviewer included, when no runtime model is configured", async () => {
    const bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: installed, providers: unconfiguredProviders() });
    try {
      const call = (who: Session, method: "GET" | "POST", url: string, payload?: object, headers: Record<string, string> = {}) =>
        bare.inject({ method, url, headers: { cookie: who.cookie, origin, "x-csrf-token": who.csrf, ...headers }, ...(payload ? { payload } : {}) });
      const read = async (who: Session) => { const r = await call(who, "GET", coursePath()); expect(r.statusCode, r.body).toBe(200); return r.json(); };
      for (const who of [admin, observer]) {
        const providers = (await read(who)).providers as { id: string; capabilities: string[]; configuration: string; detail: string }[];
        expect(providers.map((p) => p.id)).toEqual([...AGENT_ROLES]);
        for (const provider of providers) {
          expect(provider.capabilities).toEqual([provider.id]);
          expect(provider.configuration).toBe("absent");
          expect(provider.detail).toBe("Runtime status: configuration_missing. No live verification is claimed.");
        }
      }
      const request = async (who: Session, providerId: string) =>
        call(who, "POST", `${coursePath()}/providers/${providerId}/configuration-requests`, { connectionLabel: "Reviewer drafts", environment: "staging" },
          { "if-match": (await read(admin)).revision, "idempotency-key": randomUUID() });
      // The reviewer slot exists server side: an operator may file a metadata request for it.
      const accepted = await request(admin, "reviewer");
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().workspace.providers.find((p: { id: string }) => p.id === "reviewer").detail)
        .toContain("Metadata change request awaits server operator review.");
      expect((await request(admin, "not-a-role")).json().error).toBe("PROVIDER_NOT_FOUND");
      expect((await request(observer, "reviewer")).statusCode).toBe(403);
    } finally {
      await bare.close();
      await db.query("DELETE FROM admin_provider_requests WHERE catalog_id=$1 AND provider_id='reviewer'", [catalogId]);
    }
  });
  it("reads real jobs/context/decisions/artifact metadata without reasoning, prompt, output or credential leakage", async () => {
    const { id } = await enroll(),
      jobId = randomUUID(),
      inputId = randomUUID(),
      ownerId = randomUUID(),
      artifactId = randomUUID();
    const credentialCanary = randomBytes(32).toString("base64url");
    const enrollment = (
        await db.query("SELECT * FROM enrollments WHERE id=$1", [id])
      ).rows[0],
      event = (
        await db.query(
          "SELECT id FROM learning_events WHERE enrollment_id=$1 LIMIT 1",
          [id],
        )
      ).rows[0];
    const release = (
      await db.query("SELECT digest FROM course_releases WHERE id=$1", [
        releaseId,
      ])
    ).rows[0];
    const spec = {
      schemaVersion: 1 as const,
      key: { jobId, enrollmentId: id, workspaceId },
      inputEventId: event.id,
      role: "companion" as const,
      fence: {
        enrollmentRevision: enrollment.revision,
        profileRevision: enrollment.profile_revision,
        policyRevision: enrollment.policy_revision,
        ledgerRevision: 0,
        courseDigest: release.digest,
      },
      checkpoints: [
        {
          id: "generate",
          capability: "companion" as const,
          inputRef: inputId,
          allowance: { microUsd: 100, tokens: 100 },
          timeoutMs: 1000,
          maxAttempts: 1,
        },
      ],
      budget: { microUsd: 100, tokens: 100 },
      deadlineAtMs: Date.now() + 60_000,
    };
    const runtime = {
      ...createJob(spec),
      state: "waiting",
      reason: "configuration_missing",
      operations: [
        {
          id: `${jobId}/generate`,
          checkpointId: "generate",
          ownerId,
          attempt: 1,
          status: "not_started",
          reservation: { microUsd: 100, tokens: 100 },
          outcome: { status: "not_started", retryable: false },
        },
      ],
    };
    await db.query(
      "INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,input_event_id,expected_revision,specification,runtime_snapshot) VALUES($1,$2,$3,$4,'companion','waiting',$5,$6,$7,$8)",
      [
        jobId,
        id,
        workspaceId,
        randomUUID(),
        event.id,
        enrollment.revision,
        JSON.stringify(spec),
        JSON.stringify(runtime),
      ],
    );
    await db.query(
      "INSERT INTO supervisor_inputs(id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        inputId,
        jobId,
        id,
        workspaceId,
        "generate",
        JSON.stringify(spec.fence),
        JSON.stringify({
          chain_of_thought: "DO_NOT_EXPOSE_PRIVATE",
          api_key: credentialCanary,
        }),
      ],
    );
    await db.query(
      "INSERT INTO supervisor_artifacts(id,job_id,enrollment_id,workspace_id,operation_id,owner_id,digest,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        artifactId,
        jobId,
        id,
        workspaceId,
        `${jobId}/generate`,
        ownerId,
        "a".repeat(64),
        JSON.stringify({
          text: "DO_NOT_EXPOSE_OUTPUT",
          chain_of_thought: "DO_NOT_EXPOSE_PRIVATE",
        }),
      ],
    );
    await db.query("UPDATE learning_events SET payload=$2 WHERE id=$1", [
      event.id,
      JSON.stringify({ secret: "DO_NOT_EXPOSE_EVENT" }),
    ]);
    const result = await req(admin, "GET", `${coursePath()}/runs/${jobId}`);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().decisions[0].reasonCode).toBe("configuration_missing");
    expect(result.json().artifacts[0].id).toBe(artifactId);
    expect(result.json().context.some((c: any) => c.id === inputId)).toBe(true);
    expect(result.body).not.toContain("DO_NOT_EXPOSE");
    expect(result.body.includes(credentialCanary)).toBe(false);
    expect(result.body).not.toContain("chain_of_thought");
    expect(result.body).not.toContain("api_key");
    expect(
      (await req(observer, "GET", `${coursePath()}/runs/${jobId}`)).statusCode,
    ).toBe(403);
    expect(
      (await req(outsider, "GET", `${coursePath()}/runs/${jobId}`)).statusCode,
    ).toBe(403);
  });

  it("opens a run older than the newest 100 by id, within the same course scope and roles", async () => {
    const { id } = await enroll();
    // 105 runs, one minute apart; the oldest falls outside the newest-100 list.
    const jobs = (
      await db.query<{ id: string }>(
        `INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,created_at)
         SELECT gen_random_uuid(),$1,$2,'cap-' || gen_random_uuid(),'companion','applied',1,'{}'::jsonb,now() - n * interval '1 minute'
         FROM generate_series(1,105) n ORDER BY n RETURNING id`,
        [id, workspaceId],
      )
    ).rows.map((row) => row.id);
    const oldest = jobs.at(-1)!,
      newest = jobs[0]!;
    const listed = (await snapshot()).runs.map((run: { id: string }) => run.id);
    expect(listed).toHaveLength(100);
    expect(listed).toContain(newest);
    expect(listed).not.toContain(oldest);

    const result = await req(admin, "GET", `${coursePath()}/runs/${oldest}`);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ id: oldest, status: "applied" });
    expect(
      (await req(admin, "GET", `${coursePath()}/runs/${newest}`)).statusCode,
    ).toBe(200);

    // The same roles and workspace checks apply to an old run.
    expect(
      (await req(observer, "GET", `${coursePath()}/runs/${oldest}`)).statusCode,
    ).toBe(403);
    expect(
      (await req(outsider, "GET", `${coursePath()}/runs/${oldest}`)).statusCode,
    ).toBe(403);
    const missing = await req(admin, "GET", `${coursePath()}/runs/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("RUN_NOT_FOUND");

    // A run of another course in the same workspace is not found through this course.
    const other = compileCourse({ ...fixture(), id: "other-ordering" });
    const otherReleaseId = randomUUID();
    await db.query(
      "INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
      [
        otherReleaseId,
        workspaceId,
        other.server.id,
        other.server.version,
        other.digest,
        JSON.stringify(other.server),
        JSON.stringify(other.learner),
        admin.userId,
      ],
    );
    const otherCatalogId = await ensureCatalog(db, otherReleaseId);
    const learner = await session("learner");
    const otherEnrollment = await req(learner, "POST", "/api/enrollments", {
      releaseId: otherReleaseId,
    });
    expect(otherEnrollment.statusCode, otherEnrollment.body).toBe(200);
    const otherJob = randomUUID();
    await db.query(
      `INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,created_at)
       VALUES($1,$2,$3,$4,'companion','applied',1,'{}'::jsonb,now() - interval '1 day')`,
      [otherJob, otherEnrollment.json().id, workspaceId, `cap-${otherJob}`],
    );
    const crossCourse = await req(admin, "GET", `${coursePath()}/runs/${otherJob}`);
    expect(crossCourse.statusCode).toBe(404);
    expect(crossCourse.json().error).toBe("RUN_NOT_FOUND");
    expect(
      (await req(admin, "GET", `/api/admin/courses/${otherCatalogId}/runs/${otherJob}`)).statusCode,
    ).toBe(200);
    expect(
      (await req(admin, "GET", `/api/admin/courses/${otherCatalogId}/runs/${oldest}`)).statusCode,
    ).toBe(404);
  });
});
