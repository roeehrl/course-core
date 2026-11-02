import { randomUUID } from "node:crypto";
import type { FixtureContext } from "./index.js";

/** Browser fixtures of the learner AI part "checks": routes named `/test/checks-…`. */
export async function register(ctx: FixtureContext): Promise<void> {
  // A reply the companion gave this enrollment, stored as a verified reply is, so a written answer
  // that repeats it is refused (assessment-routes.ts agentAuthored). No provider is involved.
  ctx.app.post("/test/checks-companion-reply", async (request) => {
    const body = (request.body ?? {}) as { enrollmentId?: string; text?: string };
    if (!/^[0-9a-f-]{36}$/.test(String(body.enrollmentId))) return { stored: false };
    const enrollment = (await ctx.db.query<{ id: string }>("SELECT id FROM enrollments WHERE id=$1", [body.enrollmentId])).rows[0];
    if (!enrollment || typeof body.text !== "string" || !body.text.trim()) return { stored: false };
    await ctx.db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'assistant',$3,$4)",
      [randomUUID(), enrollment.id, body.text, JSON.stringify({ episodeId: null })]);
    return { stored: true };
  });
}
