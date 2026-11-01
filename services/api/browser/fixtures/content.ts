import { randomUUID } from "node:crypto";
import type { Assessment } from "@course-core/sdk";
import { gatedCourse } from "../../test/gated-fixture.js";
import type { FixtureContext, SessionHeaders } from "./index.js";

/**
 * Browser fixtures of the learner AI part "content" (AI in the lesson): routes named
 * `/test/content-…`. The supervisor's own fixtures (generated parts, new material, generated
 * models) stay `/test/model-session` in start.ts.
 *
 * `/test/content-lesson-session` publishes the gated ordering course with an optional lesson,
 * "A closer look", before "Minimum", and enrolls a learner who declined placement and read the
 * first part. With `{ struggles: true }` the learner then answers two checks wrongly, so the
 * checkpoint's decision is "Let's get you some help" with the companion offered first.
 */
export async function register(ctx: FixtureContext): Promise<void> {
  const { app, db, issueLoginCode } = ctx;
  app.post("/test/content-lesson-session", async (request) => {
    const struggles = (request.body as { struggles?: boolean } | undefined)?.struggles === true;
    const workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "content-" + workspace, "Lesson AI browser workspace"]);
    const ids = { owner: randomUUID(), learner: randomUUID() };
    for (const [role, id] of Object.entries(ids)) {
      await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "content-browser:" + id, role === "owner" ? "Owner" : "Lesson learner"]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    }
    const course = gatedCourse("5.1.0");
    course.id = "lesson-ai";
    course.title = "Lesson AI ordering";
    const chapter = course.chapters[0]!;
    chapter.episodes.unshift({
      id: "aside", title: "A closer look", objectiveIds: ["minimum"], requirement: "optional",
      blocks: [{ id: "aside-text", type: "text", markdown: "Comparing each value with the smallest one so far is enough." }],
    });
    const owner = await ctx.signIn(ids.owner);
    const created = await app.inject({ method: "POST", url: `/api/workspaces/${workspace}/releases`, headers: owner, payload: course });
    if (created.statusCode !== 200) throw Error("Lesson AI fixture release failed: " + created.body);
    const release = created.json().id as string;
    const published = await app.inject({ method: "POST", url: `/api/releases/${release}/publish`, headers: owner });
    if (published.statusCode !== 200) throw Error("Lesson AI fixture publication failed: " + published.body);
    const learner = await ctx.signIn(ids.learner);
    const enrolled = await app.inject({ method: "POST", url: "/api/enrollments", headers: learner, payload: { releaseId: release } });
    if (enrolled.statusCode !== 200) throw Error("Lesson AI fixture enrollment failed: " + enrolled.body);
    const enrollment = enrolled.json().id as string;
    const command = commander(app, learner, enrollment);
    await command("placement/decline", {});
    await command("read", { episodeId: "min", blockId: "min-text" });
    if (struggles)
      for (let attempt = 0; attempt < 2; attempt++) {
        const challenge = (await command("challenges", { episodeId: "min", mode: "independent" })).activeChallenges
          .find((row: { episodeId: string }) => row.episodeId === "min") as { challengeId: string; question: { id: string } };
        const item = course.assessments.find((row) => row.id === challenge.question.id);
        await command("answers", { challengeId: challenge.challengeId, ...wrong(item) });
      }
    return { token: await issueLoginCode(db, ids.learner) };
  });
}

/** A learner command on their own enrollment, at its current revision. */
function commander(app: FixtureContext["app"], headers: SessionHeaders, enrollment: string) {
  return async (path: string, body: Record<string, unknown>) => {
    const current = await app.inject({ url: `/api/enrollments/${enrollment}`, headers });
    const response = await app.inject({
      method: "POST", url: `/api/enrollments/${enrollment}/${path}`, headers,
      payload: { expectedRevision: current.json().revision, idempotencyKey: `content-${path.replaceAll("/", "-")}-${randomUUID()}`, ...body },
    });
    if (response.statusCode !== 200) throw Error(`Lesson AI fixture ${path} failed: ${response.body}`);
    return (await app.inject({ url: `/api/enrollments/${enrollment}`, headers })).json();
  };
}

/** A wrong answer to a check, from the course's own key; "I don't know yet" where there is none to miss. */
function wrong(item: Assessment | undefined): Record<string, unknown> {
  if (item?.type === "choice") return { answer: item.options.find((option) => option.id !== item.grading.correctOptionId)!.id };
  if (item?.type === "numeric") return { answer: Number(item.grading.expected) + 100 };
  return { abstain: true };
}
