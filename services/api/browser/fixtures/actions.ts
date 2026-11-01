import { randomUUID } from "node:crypto";
import type { FixtureContext, SessionHeaders } from "./index.js";
import { teachingContext } from "../../src/provider-context.js";
import { replyAsksLearner } from "../../src/companion-turn.js";

/*
 * Browser fixtures of the learner AI part "actions" (message actions, Based on, votes, history):
 * routes named `/test/actions-…`, on the companion-context course (its own workspace, which no
 * supervisor watches; the public ordering course without placement). Replies are stored rows, and
 * those with a capsule are built through the real provider context (no provider is called).
 *
 * - POST /test/actions-session { earlier?: number, withheld?: boolean }: a learner in the lesson
 *   "Minimum" with its check open (counted until the learner asked about it). They asked "What does
 *   minimum mean here?" (answered; with `withheld` the answer is Core's hint in place of an answer,
 *   with a capsule),
 *   then, about that check and a selection in the lesson, "Why is 4 the minimum here?", answered
 *   with a question back and a capsule. With `earlier` that many older questions and answers come
 *   first (130 messages need 63). Returns the sign-in token and the enrollment.
 * - GET /test/actions-feedback?enrollment=<id>: the feedback stored for that enrollment's replies.
 */
export async function register(ctx: FixtureContext): Promise<void> {
  const { app, db } = ctx;
  app.post("/test/actions-session", async (request) => {
    const body = (request.body ?? {}) as { earlier?: number; withheld?: boolean };
    const earlier = Math.max(0, Math.min(200, Math.floor(Number(body.earlier ?? 0)) || 0));
    const userId = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [userId, "actions:" + userId, "Actions learner"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [ctx.contextWorkspaceId, userId]);
    const headers = await ctx.signIn(userId);
    const enrollment = (await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId: ctx.contextReleaseId } })).json().id as string;
    const digest = (await db.query<{ digest: string }>("SELECT digest FROM course_releases WHERE id=$1", [ctx.contextReleaseId])).rows[0]!.digest;
    const command = async (action: string, payload: Record<string, unknown>, who: SessionHeaders = headers) => {
      const revision = (await app.inject({ url: `/api/enrollments/${enrollment}`, headers: who })).json().revision;
      const r = await app.inject({ method: "POST", url: `/api/enrollments/${enrollment}/${action}`, headers: who, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...payload } });
      if (r.statusCode !== 200) throw Error(`Actions fixture ${action} failed: ${r.body}`);
      return r.json();
    };
    if (earlier) {
      // Older questions and answers, a minute apart, two days ago: each answered (an applied job).
      const jobs = Array.from({ length: earlier }, () => randomUUID());
      await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification)
        SELECT job,$2,$3,'actions-earlier-'||job,'companion','applied',1,'{}' FROM unnest($1::uuid[]) job`, [jobs, enrollment, ctx.contextWorkspaceId]);
      await db.query(`INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id,created_at)
        SELECT gen_random_uuid(),$2,r.role,CASE r.role WHEN 'learner' THEN 'Earlier question '||g ELSE 'Earlier answer '||g END,
          jsonb_build_object('episodeId','min','courseDigest',$3::text),($1::uuid[])[g],
          clock_timestamp()-interval '2 days'+g*interval '1 minute'+CASE r.role WHEN 'learner' THEN interval '0' ELSE interval '10 seconds' END
        FROM generate_series(1,array_length($1::uuid[],1)) g CROSS JOIN (VALUES ('learner'),('assistant')) r(role)`, [jobs, enrollment, digest]);
    }
    const answer = async (asked: { messageId: string; eventId: string }, text: string, options: { capsule?: boolean; context?: Record<string, unknown> } = {}) => {
      const jobId = randomUUID();
      await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','running',1,'{}')`,
        [jobId, enrollment, ctx.contextWorkspaceId, `actions-${jobId}`]);
      await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [asked.messageId, jobId]);
      if (options.capsule) await teachingContext(db, { jobId, workspaceId: ctx.contextWorkspaceId, enrollmentId: enrollment, generation: 1 },
        { kind: "learning_event", eventId: asked.eventId, eventType: "companion.requested", courseReleaseId: ctx.contextReleaseId, episodeId: "min", messageId: asked.messageId });
      // Stored as a real reply is: with its lesson, and asksLearner only when it asks something.
      await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)",
        [randomUUID(), enrollment, text, JSON.stringify({ episodeId: "min", ...(replyAsksLearner(text) ? { asksLearner: true } : {}), ...options.context }), jobId]);
      await db.query("UPDATE supervisor_jobs SET state='applied' WHERE id=$1", [jobId]);
    };
    // The lesson read and its check open, counted.
    await command("read", { episodeId: "min", blockId: "min-text" });
    const challenge = await command("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
    const first = await command("companion", { episodeId: "min", content: "What does minimum mean here?", allowAssessmentAssistance: true });
    await answer(first, body.withheld
      ? "I can't give or confirm the answer to a graded check. Tell me your reasoning so far: which of the two values is no greater than the other?"
      : "Minimum means no greater than any other member of the list.",
    // A hint in place of an answer records what it was built from, as every reply does now.
    body.withheld ? { capsule: true, context: { checkAnswerWithheld: "answer_given" } } : {});
    const second = await command("companion", { episodeId: "min", blockId: "min-text", content: "Why is 4 the minimum here?", challengeId: challenge.challengeId,
      selection: { kind: "text", courseDigest: digest, excerpt: "no greater than" } });
    await answer(second, "Because 4 is no greater than 9.\n\nCompare them on a number line: which one is further left?", { capsule: true });
    return { token: await ctx.issueLoginCode(db, userId), enrollmentId: enrollment };
  });
  app.get("/test/actions-feedback", async (request) => {
    const enrollment = String((request.query as { enrollment?: string }).enrollment ?? "");
    if (!/^[0-9a-f-]{36}$/.test(enrollment)) return { rows: [] };
    return { rows: (await db.query("SELECT vote,comment,reported FROM companion_reply_feedback WHERE enrollment_id=$1 ORDER BY created_at", [enrollment])).rows };
  });
}
