import { randomUUID } from "node:crypto";
import { transaction } from "../../src/database.js";
import type { FixtureContext } from "./index.js";

/** The lesson and part of the ordering course a question is asked about. */
const LESSON = { episodeId: "min", blockId: "min-text" } as const;
/** A lesson id the course does not have (a lesson that left it). */
const GONE = "a-lesson-that-left";

/**
 * Browser fixtures of the learner AI part "notify" (reply notifications and unread replies):
 *
 * - `/test/notify-session`: a learner enrolled in the ordering course with one saved question
 *   about the first part of "Minimum" and no reply yet. Returns the sign-in token and the ids.
 * - `/test/notify-reply`: the companion's stored reply to that question, as the supervisor bridge
 *   applies one (a job that reached `applied`, the reply with the question's job), and, with
 *   `away`, the "your companion replied" notification it sends a learner who is not using the app
 *   (`reply_ready` with the lesson, part, question and reply ids). `lessonGone` names a lesson the
 *   course does not have. No provider and no dispatcher are involved.
 */
export async function register(ctx: FixtureContext): Promise<void> {
  const { app, db } = ctx;
  app.post("/test/notify-session", async (request) => {
    const body = (request.body ?? {}) as { question?: string };
    const userId = randomUUID();
    await db.query("INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)", [userId, `test:${userId}`, "Browser learner"]);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [ctx.workspaceId, userId]);
    const headers = await ctx.signIn(userId);
    const enrollmentId = (await app.inject({ method: "POST", url: "/api/enrollments", headers, payload: { releaseId: ctx.releaseId } })).json().id as string;
    const questionId = randomUUID();
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
      [questionId, enrollmentId, String(body.question ?? "Why is the smallest value the minimum?").slice(0, 2000), JSON.stringify(LESSON)]);
    return { token: await ctx.issueLoginCode(db, userId), enrollmentId, questionId };
  });
  app.post("/test/notify-reply", async (request) => {
    const body = (request.body ?? {}) as { questionId?: string; answer?: string; away?: boolean; lessonGone?: boolean };
    const question = (await db.query<{ id: string; enrollment_id: string; workspace_id: string; user_id: string }>(
      `SELECT m.id,m.enrollment_id,e.workspace_id,e.user_id FROM companion_messages m JOIN enrollments e ON e.id=m.enrollment_id
        WHERE m.id::text=$1 AND m.role='learner'`, [String(body.questionId)])).rows[0];
    if (!question) return { replied: false, reason: "question_not_found" };
    const jobId = randomUUID(), replyId = randomUUID();
    // In one transaction, as a real reply is applied: a read never finds the job finished without its reply.
    await transaction(db, async (client) => {
      await client.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,result)
        VALUES ($1,$2,$3,$4,'companion','applied',1,'{}',$5)`, [jobId, question.enrollment_id, question.workspace_id, `browser-notify-${jobId}`,
        JSON.stringify({ reason: null, applicationReceiptId: null })]);
      await client.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [question.id, jobId]);
      await client.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)",
        [replyId, question.enrollment_id, String(body.answer ?? "A stored reply.").slice(0, 4000), JSON.stringify({ episodeId: LESSON.episodeId }), jobId]);
    });
    if (body.away)
      await ctx.notifyUser(db, { workspaceId: question.workspace_id, userId: question.user_id, audience: "learner", kind: "reply_ready",
        enrollmentId: question.enrollment_id, link: `/enrollments/${question.enrollment_id}/companion`, dedupeKey: `reply-ready:${replyId}`,
        params: { episodeId: body.lessonGone ? GONE : LESSON.episodeId, blockId: LESSON.blockId, questionMessageId: question.id, replyMessageId: replyId } });
    return { replied: true, replyMessageId: replyId };
  });
}
