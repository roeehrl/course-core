import { z } from "zod";

/** What learners spend on AI (GET .../provider-spend/learners), for choosing a per-learner limit. */
const amount = z.string().regex(/^\d+$/);
const micro = z.number().nonnegative();
const spread = z.object({ p50: micro, p90: micro, max: micro });
const sums = z.object({
  calls: z.number().int().nonnegative(),
  reserved: amount,
  charged: amount,
  actual: amount,
  reconciledCalls: z.number().int().nonnegative(),
  reconciledCharged: amount,
});
const id = z.string().max(200);
export const learnerSpendSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.number().int().positive(),
  timeZone: z.literal("UTC"),
  currency: z.literal("USD"),
  learners: z.number().int().nonnegative(),
  learnerDays: z.number().int().nonnegative(),
  distributions: z.object({
    learnerDay: spread,
    activeHour: spread,
    learnerTotal: spread,
  }),
  totals: sums,
  byRole: z
    .array(sums.extend({ role: z.string().max(32), learners: z.number() }))
    .max(8),
  byLesson: z
    .array(sums.extend({ episodeId: id.nullable(), learners: z.number() }))
    .max(20),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(25),
  totalLearners: z.number().int().nonnegative(),
  rows: z
    .array(
      sums.extend({
        enrollmentId: z.string().uuid(),
        courseKey: id,
        activeDays: z.number().int().nonnegative(),
        activeHours: z.number().int().nonnegative(),
        perDay: spread,
        byRole: z.array(sums.extend({ role: z.string().max(32) })).max(8),
        byLesson: z.array(sums.extend({ episodeId: id.nullable() })).max(10),
        byDay: z
          .array(
            z.object({
              day: z.string().max(10),
              charged: amount,
              calls: z.number(),
            }),
          )
          .max(93),
      }),
    )
    .max(25),
  recommendation: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("not_enough_data"),
      learners: z.number().int(),
      learnerDays: z.number().int(),
      minimumLearners: z.number().int(),
      minimumLearnerDays: z.number().int(),
    }),
    z.object({
      status: z.literal("ready"),
      microUsd: z.number().int().positive(),
      dailyMicroUsd: z.number().int().positive(),
      basis: z.object({
        learners: z.number().int(),
        learnerDays: z.number().int(),
        windowDays: z.number().int(),
        margin: z.number().positive(),
        p90LearnerTotalMicroUsd: micro,
        p90LearnerDayMicroUsd: micro,
        cappedAtWorkspaceTotal: z.boolean(),
      }),
    }),
  ]),
});
export type LearnerSpend = z.infer<typeof learnerSpendSchema>;
export interface LearnerSpendQuery {
  /** Inclusive UTC dates, YYYY-MM-DD. */
  from: string;
  to: string;
  page: number;
  pageSize: number;
}
export interface LearnerSpendPort {
  learnerSpend(
    workspace: string,
    query: LearnerSpendQuery,
    signal?: AbortSignal,
  ): Promise<LearnerSpend>;
}
/** The last `days` UTC days up to and including today. */
export function lastDays(days: number, now = new Date()) {
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}
export function learnerSpendPath(workspace: string, query: LearnerSpendQuery) {
  const search = new URLSearchParams({
    from: query.from,
    to: query.to,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  return `/workspaces/${encodeURIComponent(workspace)}/provider-spend/learners?${search}`;
}
