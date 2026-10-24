// i18n-ignore-file: fictional demo lesson ids and course keys are course content, like src/data/
import { AdminError } from "../domain/errors";
import type {
  LearnerSpend,
  LearnerSpendPort,
  LearnerSpendQuery,
} from "../domain/learnerSpend";

/**
 * The demo's learner spending: fictional AI calls for fourteen learners over the last weeks,
 * aggregated in memory the way the server does (UTC days, median / 90th percentile / highest,
 * a suggested limit for each learner from 5 learners and 20 learner-days). No provider is
 * called and nothing is saved.
 */
export interface DemoLearnerSpendOptions {
  scenario?:
    "standard" | "permission_denied" | "stale_revision" | "load_failure";
  latency?: number;
  now?: () => Date;
  /** The workspace total, so the suggestion is capped like the server's. */
  workspaceLimitMicroUsd?: number;
}
interface Call {
  enrollmentId: string;
  courseKey: string;
  day: string;
  hour: number;
  role: string;
  episodeId: string | null;
  charged: number;
  reserved: number;
  actual: number | null;
}
const DAY = 86_400_000;
const LEARNERS = Array.from({ length: 14 }, (_, n) => ({
  id: `5e1d0000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
  course: n < 6 ? "ordering" : "graphs",
  /** Typical cost of one call for this learner, in micro-USD. */
  rate: 20_000 + n * 9_000,
  days: 3 + (n % 4) * 2,
}));
const LESSONS = ["min", "max", "sort"] as const;
const ROLES = ["companion", "supervisor", "research"] as const;
/** percentile_cont over sorted values, rounded like the server. */
function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const at = p * (sorted.length - 1),
    low = Math.floor(at),
    high = Math.ceil(at);
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low));
}
const spread = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: Math.round(sorted.at(-1) ?? 0),
  };
};
function sums(calls: Call[]) {
  const reconciled = calls.filter((c) => c.actual !== null);
  const total = (values: number[]) => String(values.reduce((a, b) => a + b, 0));
  return {
    calls: calls.length,
    reserved: total(calls.map((c) => c.reserved)),
    charged: total(calls.map((c) => c.charged)),
    actual: total(reconciled.map((c) => c.actual!)),
    reconciledCalls: reconciled.length,
    reconciledCharged: total(reconciled.map((c) => c.charged)),
  };
}
function group<K extends keyof Call>(calls: Call[], key: K) {
  const map = new Map<Call[K], Call[]>();
  for (const call of calls)
    map.set(call[key], [...(map.get(call[key]) ?? []), call]);
  return [...map.entries()];
}
const byCharged = (a: { charged: string }, b: { charged: string }) =>
  Number(b.charged) - Number(a.charged);
function demoCalls(now: Date): Call[] {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const calls: Call[] = [];
  LEARNERS.forEach((learner, n) => {
    for (let d = 0; d < learner.days; d++) {
      const day = new Date(today - (d * 2 + n) * DAY)
        .toISOString()
        .slice(0, 10);
      for (let c = 0; c < 2 + ((n + d) % 3); c++) {
        const charged = learner.rate * (1 + ((c + d) % 3));
        calls.push({
          enrollmentId: learner.id,
          courseKey: learner.course,
          day,
          hour: 9 + c * 2,
          role: ROLES[(c + n) % ROLES.length]!,
          episodeId: c === 2 ? null : LESSONS[(d + n) % LESSONS.length]!,
          charged,
          reserved: charged * 2,
          actual: n % 3 === 0 ? charged : null,
        });
      }
    }
  });
  return calls;
}

export function demoLearnerSpendView(
  query: LearnerSpendQuery,
  options: DemoLearnerSpendOptions = {},
): LearnerSpend {
  const now = options.now?.() ?? new Date();
  const calls = demoCalls(now).filter(
    (c) => c.day >= query.from && c.day <= query.to,
  );
  // One learner-day per learner and UTC day, with its distinct active hours.
  const perDay = new Map<string, Call[]>();
  for (const call of calls) {
    const key = `${call.enrollmentId}|${call.day}`;
    perDay.set(key, [...(perDay.get(key) ?? []), call]);
  }
  const days = [...perDay.values()].map((list) => ({
    enrollmentId: list[0]!.enrollmentId,
    charged: list.reduce((a, c) => a + c.charged, 0),
    hours: new Set(list.map((c) => c.hour)).size,
  }));
  const learners = group(calls, "enrollmentId")
    .map(([id, list]) => ({
      id: id as string,
      list,
      charged: list.reduce((a, c) => a + c.charged, 0),
      days: days.filter((d) => d.enrollmentId === id),
    }))
    .sort((a, b) => b.charged - a.charged || a.id.localeCompare(b.id));
  const distributions = {
    learnerDay: spread(days.map((d) => d.charged)),
    activeHour: spread(days.map((d) => d.charged / Math.max(1, d.hours))),
    learnerTotal: spread(learners.map((l) => l.charged)),
  };
  const windowDays =
    Math.round((Date.parse(query.to) - Date.parse(query.from)) / DAY) + 1;
  const step = (value: number, size: number) =>
    Math.max(size, Math.ceil(value / size) * size);
  const limit = options.workspaceLimitMicroUsd ?? 25_000_000;
  const enough = learners.length >= 5 && days.length >= 20;
  const raw = step(distributions.learnerTotal.p90 * 1.5, 500_000),
    capped = limit > 0 && raw > limit;
  const page = learners.slice(
    (query.page - 1) * query.pageSize,
    query.page * query.pageSize,
  );
  return {
    from: `${query.from}T00:00:00.000Z`,
    to: new Date(Date.parse(query.to) + DAY).toISOString(),
    days: windowDays,
    timeZone: "UTC",
    currency: "USD",
    learners: learners.length,
    learnerDays: days.length,
    distributions,
    totals: sums(calls),
    byRole: group(calls, "role")
      .map(([role, list]) => ({
        role: role as string,
        learners: new Set(list.map((c) => c.enrollmentId)).size,
        ...sums(list),
      }))
      .sort(byCharged),
    byLesson: group(calls, "episodeId")
      .map(([episodeId, list]) => ({
        episodeId: episodeId as string | null,
        learners: new Set(list.map((c) => c.enrollmentId)).size,
        ...sums(list),
      }))
      .sort(byCharged),
    page: query.page,
    pageSize: query.pageSize,
    totalLearners: learners.length,
    rows: page.map((learner) => ({
      enrollmentId: learner.id,
      courseKey: learner.list[0]!.courseKey,
      activeDays: learner.days.length,
      activeHours: learner.days.reduce((a, d) => a + d.hours, 0),
      perDay: spread(learner.days.map((d) => d.charged)),
      ...sums(learner.list),
      charged: String(learner.charged),
      byRole: group(learner.list, "role").map(([role, list]) => ({
        role: role as string,
        ...sums(list),
      })),
      byLesson: group(learner.list, "episodeId")
        .map(([episodeId, list]) => ({
          episodeId: episodeId as string | null,
          ...sums(list),
        }))
        .sort(byCharged)
        .slice(0, 10),
      byDay: group(learner.list, "day")
        .map(([day, list]) => ({
          day: day as string,
          charged: String(list.reduce((a, c) => a + c.charged, 0)),
          calls: list.length,
        }))
        .sort((a, b) => b.day.localeCompare(a.day)),
    })),
    recommendation: enough
      ? {
          status: "ready",
          microUsd: capped ? limit : raw,
          dailyMicroUsd: step(distributions.learnerDay.p90 * 1.5, 100_000),
          basis: {
            learners: learners.length,
            learnerDays: days.length,
            windowDays,
            margin: 1.5,
            p90LearnerTotalMicroUsd: distributions.learnerTotal.p90,
            p90LearnerDayMicroUsd: distributions.learnerDay.p90,
            cappedAtWorkspaceTotal: capped,
          },
        }
      : {
          status: "not_enough_data",
          learners: learners.length,
          learnerDays: days.length,
          minimumLearners: 5,
          minimumLearnerDays: 20,
        },
  };
}

export function createDemoLearnerSpend(
  options: DemoLearnerSpendOptions = {},
): LearnerSpendPort {
  return {
    async learnerSpend(_workspace, query, signal) {
      if (options.latency)
        await new Promise((resolve) => setTimeout(resolve, options.latency));
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (options.scenario === "load_failure")
        throw new AdminError("unavailable");
      if (options.scenario === "permission_denied")
        throw new AdminError("permission_denied");
      return demoLearnerSpendView(query, options);
    },
  };
}
