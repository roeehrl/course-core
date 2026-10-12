import type { Enrollment } from "../domain/contracts";
import type { LearningPolicy, ScopePolicy, Quota } from "../domain/policy";

/** Public illustrative enrollment policy. Calendar values are persisted anchors. */
export function demoLearningPolicy(enrollment: Enrollment): LearningPolicy {
  const extension = (scope: string) => ({
    enabled: true,
    learnerAcceptanceRequired: true as const,
    poolIds: [`${scope}:calendar`],
    requiredAuthorityIds: [],
    offerCooldownHours: 24,
    maxOutstandingOffersPerScope: 1,
    maxOffersPerScope: 6,
  });
  const window = (scope: string, at: string, days: number, end: string) => ({
    anchorId: `${enrollment.id}:${scope}`,
    anchor: "scope_started" as const,
    anchorInstant: at,
    calendarDays: days,
    timeZone: "UTC",
    disambiguation: "compatible" as const,
    pauseRule: "approved_only" as const,
    resolvedDeadline: end,
  });
  const scopes: ScopePolicy[] = [
    {
      scopeId: "course",
      label: "Whole course",
      parentScopeId: null,
      policyId: "course@1",
      kind: "course",
      mode: "bounded",
      targetDate: "2026-11-25T17:00:00Z",
      hardDeadline: {
        at: "2026-12-01T17:00:00Z",
        timeZone: "UTC",
        disambiguation: "reject",
      },
      ultimateDeadline: "2026-12-10T17:00:00Z",
      work: {
        additionalMinutes: 240,
        additionalEpisodes: 8,
        remediationCyclesPerConcept: 3,
      },
      extensions: extension("course"),
      existingMaterialAccess: "read_only",
    },
    {
      scopeId: "chapter:foundations",
      label: "Chapter · Foundations",
      parentScopeId: "course",
      policyId: "foundations@1",
      kind: "chapter",
      mode: "bounded",
      targetDate: "2026-10-25T09:00:00Z",
      window: window(
        "chapter:foundations",
        "2026-10-12T09:00:00Z",
        14,
        "2026-10-26T09:00:00Z",
      ),
      hardDeadline: {
        at: "2026-11-02T09:00:00Z",
        timeZone: "UTC",
        disambiguation: "reject",
      },
      work: {
        additionalMinutes: 90,
        additionalEpisodes: 3,
        remediationCyclesPerConcept: 2,
      },
      extensions: extension("chapter:foundations"),
      existingMaterialAccess: "read_only",
      submissionGraceUntil: "2026-10-27T09:00:00Z",
    },
    {
      scopeId: "episode:notice",
      label: "Episode · Notice a pattern",
      parentScopeId: "chapter:foundations",
      policyId: "notice@1",
      kind: "episode",
      mode: "bounded",
      window: window(
        "episode:notice",
        "2026-10-13T09:00:00Z",
        3,
        "2026-10-16T09:00:00Z",
      ),
      work: {
        additionalMinutes: 30,
        additionalEpisodes: 1,
        remediationCyclesPerConcept: 1,
      },
      extensions: extension("episode:notice"),
      existingMaterialAccess: "read_only",
    },
    {
      scopeId: "episode:apply",
      label: "Episode · Apply the idea",
      parentScopeId: "chapter:foundations",
      policyId: "apply@1",
      kind: "episode",
      mode: "bounded",
      window: window(
        "episode:apply",
        "2026-10-23T09:00:00Z",
        3,
        "2026-10-26T09:00:00Z",
      ),
      work: { additionalMinutes: 30, additionalEpisodes: 1 },
      extensions: extension("episode:apply"),
      existingMaterialAccess: "read_only",
    },
    {
      scopeId: "chapter:explore",
      label: "Chapter · Open exploration",
      parentScopeId: "course",
      policyId: "explore@1",
      kind: "chapter",
      mode: "open_ended",
      work: {},
      existingMaterialAccess: "read_only",
    },
  ];
  const pools = scopes
    .filter((scope) => scope.extensions)
    .map((scope) => ({
      poolId: `${scope.scopeId}:calendar`,
      scopeIds: [scope.scopeId],
      unit: "calendar_day" as const,
      total: scope.kind === "course" ? 10 : 5,
      maxGrants: 2,
      maxPerGrant: scope.kind === "course" ? 5 : 3,
    }));
  const policy: LearningPolicy = {
    enrollmentId: enrollment.id,
    learnerId: enrollment.learnerRef,
    revision: 1,
    policyRevision: 1,
    ledgerRevision: 1,
    status: enrollment.status === "paused" ? "paused" : "active",
    scopes,
    pools,
    constraints: [],
    balances: pools.map((pool) => ({
      poolId: pool.poolId,
      remaining: pool.total,
      grantsRemaining: pool.maxGrants,
    })),
    offers: [],
    grants: [],
    rationaleEvents: enrollment.evidence.map((e) => ({
      id: e.id,
      label: `${e.objective} · ${e.status}`,
    })),
    activities: [
      { id: "notice", scopeId: "episode:notice", label: "Notice a pattern" },
      { id: "apply", scopeId: "episode:apply", label: "Apply the idea" },
    ],
  };
  policy.constraints = scopes.map((scope) =>
    resolveDemoConstraints(policy, scope.scopeId),
  );
  return policy;
}

/** Deterministic fixture-only projection; connected UIs display server snapshots. */
export function resolveDemoConstraints(
  policy: LearningPolicy,
  scopeId: string,
): LearningPolicy["constraints"][number] {
  const path: ScopePolicy[] = [];
  let cursor = policy.scopes.find((s) => s.scopeId === scopeId);
  while (cursor) {
    path.unshift(cursor);
    cursor = policy.scopes.find((s) => s.scopeId === cursor!.parentScopeId);
  }
  const deadlines: LearningPolicy["constraints"][number]["deadlines"] =
    path.flatMap((scope) => [
      ...(scope.hardDeadline
        ? [
            {
              scopeId: scope.scopeId,
              kind: "absolute" as const,
              at: scope.hardDeadline.at,
            },
          ]
        : []),
      ...(scope.window
        ? [
            {
              scopeId: scope.scopeId,
              kind: "window" as const,
              at: scope.window.resolvedDeadline,
            },
          ]
        : []),
      ...(scope.ultimateDeadline
        ? [
            {
              scopeId: scope.scopeId,
              kind: "ultimate" as const,
              at: scope.ultimateDeadline,
            },
          ]
        : []),
    ]);
  const effectiveDeadline = deadlines.length
    ? [...deadlines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]!.at
    : null;
  const quotas: Quota[] = path.flatMap((scope) =>
    Object.entries(scope.work).map(([metric, limit]) => {
      const old = policy.constraints
        .find((c) => c.scopeId === scope.scopeId)
        ?.quotas.find(
          (q) => q.scopeId === scope.scopeId && q.metric === metric,
        );
      const consumed =
        old?.consumed ?? (metric === "additionalMinutes" ? 10 : 0);
      const reserved =
        old?.reserved ?? (metric === "additionalMinutes" ? 5 : 0);
      return {
        scopeId: scope.scopeId,
        metric: metric as Quota["metric"],
        conceptId:
          metric === "remediationCyclesPerConcept" ? "core-idea" : null,
        limit,
        consumed,
        reserved,
        remaining: Math.max(0, limit - consumed - reserved),
      };
    }),
  );
  return {
    enrollmentId: policy.enrollmentId,
    scopeId,
    policyRevision: policy.policyRevision,
    ledgerRevision: policy.ledgerRevision,
    ancestorScopeIds: path.map((scope) => scope.scopeId),
    effectiveDeadline,
    deadlines,
    bindingDeadlines: deadlines.filter((d) => d.at === effectiveDeadline),
    quotas,
    existingMaterialAccess: path.some(
      (scope) => scope.existingMaterialAccess === "closed",
    )
      ? "closed"
      : "read_only",
  };
}
