import { randomUUID } from "node:crypto";
import type { FixtureContext } from "./index.js";

/**
 * Browser fixtures of the learner AI part "conversation": routes named `/test/conversation-…`.
 *
 * `/test/conversation-reply` answers the newest saved question with this text as a stored reply,
 * with the context flags a test names (`asksLearner`, `cutShort`, `checkAnswerWithheld`) exactly
 * as given. Unlike `/test/companion-job` (which stores `asksLearner` the way the supervisor does),
 * nothing is derived: a reply stored before the flag existed is written without it, so the learner
 * app's own fallback is exercised.
 *
 * `/test/conversation-dispatch` is a question whose call went out: its job is running with one
 * operation in flight (so stopping it counts as stopped after it was sent), and the scripted
 * pieces stream into that job's draft, as the provider gateway would while a model streams. The
 * learner's Stop then cancels that very draft. No provider and no dispatcher are involved.
 */
export async function register({ app, db, replyDrafts }: FixtureContext): Promise<void> {
  app.post("/test/conversation-reply", async (request) => {
    const body = (request.body ?? {}) as { question?: string; content?: string; asksLearner?: boolean; cutShort?: boolean; checkAnswerWithheld?: string };
    const row = (await db.query<{ id: string; enrollment_id: string; workspace_id: string; context: { episodeId?: string } }>(
      "SELECT m.id,m.enrollment_id,e.workspace_id,m.context FROM companion_messages m JOIN enrollments e ON e.id=m.enrollment_id WHERE m.content=$1 AND m.role='learner' ORDER BY m.created_at DESC LIMIT 1",
      [String(body.question)])).rows[0];
    if (!row || typeof body.content !== "string" || body.content.length > 4000) return { answered: false, reason: row ? "invalid_content" : "question_not_found" };
    const jobId = randomUUID();
    await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,result)
      VALUES ($1,$2,$3,$4,'companion','applied',1,'{}',$5)`, [jobId, row.enrollment_id, row.workspace_id, `browser-reply-${jobId}`,
      JSON.stringify({ reason: null, applicationReceiptId: null })]);
    await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [row.id, jobId]);
    const context = {
      episodeId: row.context.episodeId ?? null,
      ...(typeof body.asksLearner === "boolean" ? { asksLearner: body.asksLearner } : {}),
      ...(body.cutShort === true ? { cutShort: true } : {}),
      ...(typeof body.checkAnswerWithheld === "string" ? { checkAnswerWithheld: body.checkAnswerWithheld } : {}),
    };
    const id = randomUUID();
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,$4,$5)",
      [id, row.enrollment_id, body.content, JSON.stringify(context), jobId]);
    return { answered: true, messageId: id, jobId };
  });
  app.post("/test/conversation-dispatch", async (request) => {
    const body = (request.body ?? {}) as { question?: string; pieces?: string[]; gapMs?: number; end?: "complete" };
    const row = (await db.query<{ id: string; enrollment_id: string; workspace_id: string }>(
      "SELECT m.id,m.enrollment_id,e.workspace_id FROM companion_messages m JOIN enrollments e ON e.id=m.enrollment_id WHERE m.content=$1 AND m.role='learner' ORDER BY m.created_at DESC LIMIT 1",
      [String(body.question)])).rows[0];
    if (!row || !Array.isArray(body.pieces) || body.pieces.length > 40) return { opened: false, reason: row ? "invalid_pieces" : "question_not_found" };
    const jobId = randomUUID();
    const requested = (await db.query<{ id: string }>("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested' AND payload->>'messageId'=$2::text",
      [row.enrollment_id, row.id])).rows[0]?.id ?? null;
    const snapshot = requested ? { specification: { key: { jobId, enrollmentId: row.enrollment_id, workspaceId: row.workspace_id } }, state: "running",
      operations: [{ id: `${jobId}:generate`, status: "in_flight" }] } : null;
    await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,result,runtime_snapshot,input_event_id)
      VALUES ($1,$2,$3,$4,'companion','running',1,'{}','{}',$5,$6)`, [jobId, row.enrollment_id, row.workspace_id, `browser-dispatch-${jobId}`,
      snapshot ? JSON.stringify(snapshot) : null, requested]);
    await db.query("UPDATE companion_messages SET job_id=$2 WHERE id=$1", [row.id, jobId]);
    const writer = replyDrafts().open({ enrollmentId: row.enrollment_id, jobId, messageId: row.id });
    if (!writer) return { opened: false, reason: "draft_refused" };
    void (async () => {
      for (const piece of body.pieces!) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(body.gapMs ?? 150, 2000)));
        writer.push(String(piece));
      }
      if (body.end === "complete") writer.complete();
    })();
    return { opened: true, jobId };
  });
}
