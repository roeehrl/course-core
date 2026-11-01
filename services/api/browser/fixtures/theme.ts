import { randomUUID } from "node:crypto";
import { teachingContext } from "../../src/provider-context.js";
import type { FixtureContext } from "./index.js";

/* A short saved conversation on the ordering course's first lesson: the learner's question and a
 * reply in Markdown with a list, inline code and a fenced block, so the dark theme is checked on
 * the bubble, the reply and its code as well as on the empty companion. Course-neutral text. */
const QUESTION = "Why is 2 the smaller value?";
const ANSWER = [
  "Compare the two values one at a time:",
  "",
  "1. Start with the first value, `2`.",
  "2. Ask whether the next value is smaller. `5` is not, so `2` stays the minimum.",
  "",
  "```python",
  "values = [2, 5]",
  "smallest = min(values)",
  "```",
].join("\n");

/** Browser fixtures of the learner AI part "theme": routes named `/test/theme-…`. */
export async function register(ctx: FixtureContext): Promise<void> {
  const { app, db, workspaceId, releaseId } = ctx;
  // A learner enrolled in the ordering course; with `conversation`, one answered question.
  app.post("/test/theme-session", async (request) => {
    const body = (request.body ?? {}) as { conversation?: boolean };
    const userId = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [userId, `theme:${userId}`, "Theme learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, userId]);
    const headers = await ctx.signIn(userId);
    const enrolled = await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId } });
    if (enrolled.statusCode >= 300) throw Error("Theme fixture enrollment failed: " + enrolled.body);
    const enrollment = enrolled.json().id as string;
    if (body.conversation) {
      const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers })).json().revision;
      const asked = await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/companion`, headers,
        payload: { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", content: QUESTION } });
      if (asked.statusCode !== 200) throw Error("Theme fixture question failed: " + asked.body);
      const question = asked.json() as { messageId: string; eventId: string };
      const jobId = randomUUID();
      await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','running',1,'{}')`,
        [jobId, enrollment, workspaceId, `browser-theme-${jobId}`]);
      await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [question.messageId, jobId]);
      await teachingContext(db, { jobId, workspaceId, enrollmentId: enrollment, generation: 1 },
        { kind: "learning_event", eventId: question.eventId, eventType: "companion.requested", courseReleaseId: releaseId, episodeId: "min", messageId: question.messageId });
      await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{}',$4)",
        [randomUUID(), enrollment, ANSWER, jobId]);
      await db.query("UPDATE supervisor_jobs SET state='applied' WHERE id=$1", [jobId]);
    }
    return { token: await ctx.issueLoginCode(db, userId) };
  });
}
