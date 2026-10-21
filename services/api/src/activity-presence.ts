import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { ApiError, requireCondition } from "./errors.js";
import { memberRole } from "./course-access.js";

/**
 * Where a learner is working right now (requirement E03): the "activity in progress" signal the
 * safe-boundary rule reads (generated-content.ts safeBoundary). The learner app reports `open` when
 * the learner starts using an interactive part of a lesson, repeats it while that part stays in
 * view, and reports `closed` when they leave it (scrolled away, tab hidden, page left, part
 * finished). Saving an activity's state also counts as open. A report lapses after
 * PRESENCE_TTL_SECONDS without a repeat, so a crashed tab never holds a change back for long, and
 * an explicit close lets a waiting change land at once. Nothing here is evidence.
 */
export const PRESENCE_TTL_SECONDS = 90;
/** Repeats closer together than this change nothing (the app repeats about every 45 s). */
export const PRESENCE_MIN_REFRESH_SECONDS = 15;
/** Lesson parts tracked per enrollment; closed and lapsed ones make room first. */
export const PRESENCE_MAX_PARTS = 32;
export type PresenceKind = "activity" | "simulation" | "component";

/** Records that the learner is using (or has left) one part of a lesson. */
export async function recordPresence(client: PoolClient, enrollment: { id: string; workspace_id: string },
  input: { episodeId: string; blockId: string; kind: PresenceKind; state: "open" | "closed" },
  /** "skip": a full table records nothing instead of refusing (for reports made on the way). */
  full: "refuse" | "skip" = "refuse") {
  if (input.state === "closed") {
    await client.query("UPDATE activity_presence SET closed_at=clock_timestamp() WHERE enrollment_id=$1 AND episode_id=$2 AND block_id=$3 AND closed_at IS NULL",
      [enrollment.id, input.episodeId, input.blockId]);
    return { state: "closed" as const };
  }
  // A repeat inside the refresh interval writes nothing.
  const fresh = await client.query(`SELECT 1 FROM activity_presence WHERE enrollment_id=$1 AND episode_id=$2 AND block_id=$3 AND closed_at IS NULL
    AND seen_at>clock_timestamp()-make_interval(secs=>$4) AND expires_at>clock_timestamp()`, [enrollment.id, input.episodeId, input.blockId, PRESENCE_MIN_REFRESH_SECONDS]);
  if (!fresh.rowCount) {
    const known = await client.query("SELECT 1 FROM activity_presence WHERE enrollment_id=$1 AND episode_id=$2 AND block_id=$3", [enrollment.id, input.episodeId, input.blockId]);
    if (!known.rowCount) {
      // Make room: parts the learner left or that lapsed go first; open ones are never dropped.
      await client.query(`DELETE FROM activity_presence WHERE enrollment_id=$1 AND (closed_at IS NOT NULL OR expires_at<=clock_timestamp())
        AND (SELECT count(*) FROM activity_presence WHERE enrollment_id=$1)>=$2`, [enrollment.id, PRESENCE_MAX_PARTS]);
      const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_presence WHERE enrollment_id=$1", [enrollment.id])).rows[0]!.n;
      if (count >= PRESENCE_MAX_PARTS) {
        if (full === "skip") return { state: "open" as const, recorded: false };
        throw new ApiError(429, "PRESENCE_LIMIT");
      }
    }
    await client.query(`INSERT INTO activity_presence(enrollment_id,workspace_id,episode_id,block_id,kind,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(secs=>$6))
      ON CONFLICT (enrollment_id,episode_id,block_id) DO UPDATE SET kind=EXCLUDED.kind,seen_at=clock_timestamp(),expires_at=EXCLUDED.expires_at,closed_at=NULL,
        opened_at=CASE WHEN activity_presence.closed_at IS NULL AND activity_presence.expires_at>clock_timestamp() THEN activity_presence.opened_at ELSE clock_timestamp() END`,
    [enrollment.id, enrollment.workspace_id, input.episodeId, input.blockId, input.kind, PRESENCE_TTL_SECONDS]);
  }
  return { state: "open" as const, recorded: true, expiresInSeconds: PRESENCE_TTL_SECONDS };
}

/** Whether the learner is working in a part of this lesson now: reported open, not left, not lapsed. */
export async function presenceOpen(client: PoolClient, enrollmentId: string, episodeId: string) {
  return Boolean((await client.query("SELECT 1 FROM activity_presence WHERE enrollment_id=$1 AND episode_id=$2 AND closed_at IS NULL AND expires_at>clock_timestamp() LIMIT 1",
    [enrollmentId, episodeId])).rowCount);
}

const part = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" };
export function registerPresenceRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  // The learner's own presence only. It changes no revision, so it never makes the app reload.
  app.post("/api/enrollments/:enrollmentId/presence", {
    bodyLimit: 2048,
    schema: {
      params: { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["episodeId", "blockId", "kind", "state"], properties: {
        episodeId: part, blockId: part, kind: { enum: ["activity", "simulation", "component"] }, state: { enum: ["open", "closed"] } } },
    },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as { episodeId: string; blockId: string; kind: PresenceKind; state: "open" | "closed" };
    return transaction(db, async (client) => {
      const enrollment = (await client.query<{ id: string; workspace_id: string; user_id: string; status: string }>(
        "SELECT id,workspace_id,user_id,status FROM enrollments WHERE id=$1 FOR SHARE", [enrollmentId])).rows[0];
      requireCondition(enrollment && enrollment.status !== "erased", "ENROLLMENT_NOT_FOUND", 404);
      await memberRole(client, actor, enrollment.workspace_id);
      requireCondition(enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      return recordPresence(client, enrollment, input);
    });
  });
}
