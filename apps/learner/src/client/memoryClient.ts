import { CourseApiError, type CourseApi } from "./apiClient";
import { randomId } from "./webCrypto";

export type MemoryPace = "gentle" | "steady" | "focused";
export type MemoryStyle = "concise" | "step_by_step" | "worked_example";
export const MEMORY_EXPERIENCE = ["new", "some", "experienced"] as const;
export const MEMORY_DEPTH = ["overview", "standard", "deep"] as const;
export const MEMORY_ACCESSIBILITY = ["captions", "transcript", "screen_reader", "reduced_motion", "keyboard_only", "audio_description", "plain_language"] as const;
export interface MemoryProfile {
  preferences: {
    pace?: MemoryPace;
    explanationStyle?: MemoryStyle;
    goal?: string;
    /** Languages the learner is comfortable learning in, most preferred first (BCP 47 tags). */
    languages?: string[];
    experience?: (typeof MEMORY_EXPERIENCE)[number];
    depth?: (typeof MEMORY_DEPTH)[number];
    /** Minutes the learner plans to spend each week. */
    weeklyMinutes?: number;
    accessibility?: (typeof MEMORY_ACCESSIBILITY)[number][];
  };
  priorKnowledge: { objectiveId: string; statement: string }[];
  thoughts: string;
}
export type MemorySuggestion =
  | { kind: "pace"; value: MemoryPace }
  | { kind: "explanation_style"; value: MemoryStyle }
  | { kind: "review_objective"; objectiveId: string };
export interface MemorySource {
  eventId: string;
  cursor: string;
  eventType: string;
  digest: string;
}
/** Where a suggestion came from: the course's own AI, or an agent the learner connected. */
export type MemoryProposalOrigin =
  | { kind: "course_ai" }
  | { kind: "connected_agent"; grantId: string; label: string | null };
export interface MemoryProposal {
  proposalId: string;
  /** Absent from older servers; treated as the course's own AI. */
  origin?: MemoryProposalOrigin;
  status: "pending" | "accepted" | "corrected" | "disputed" | "source_revoked" | "expired";
  /** How uncertain Core is of the suggestion, from how much of the learner's activity it rests
   * on; null when not stated (older suggestions). Absent from older servers. */
  uncertainty?: "low" | "medium" | "high" | null;
  /** Until when it is offered for review; null when it never expires. Absent from older servers. */
  expiresAt?: string | null;
  suggestion: MemorySuggestion;
  originalSuggestion: MemorySuggestion;
  decisionId: string | null;
  grantsMastery: false;
  sourceEventRefs: MemorySource[];
}
/** Skill projection. Each state names its basis; self-report never changes it. */
export type MemorySkillStatus =
  | "not_assessed"
  | "needs_evidence"
  | "practicing"
  | "demonstrated"
  | "retained"
  | "needs_review"
  | "disputed";
export type MemoryUnderstanding = {
  objectiveId: string;
  /** Why this state was given (server copy). */
  explanation?: string;
  evidenceRefs: {
    evidenceId: string;
    attemptId: string;
    courseDigest: string;
    /** An open dispute the learner raised about this result. */
    disputed?: boolean;
    /** Kept out of what the companion and supervisor receive. */
    excluded?: boolean;
    /** Provenance: the evaluator, who decided it and when it was recorded (absent from older servers). */
    evaluator?: string;
    decidedBy?: "automatic_check" | "staff_review" | "second_opinion" | "staff_regrade";
    recordedAt?: string;
  }[];
  demonstrated: boolean;
  retention: "not_scheduled" | "scheduled" | "retained" | "needs_review";
  retentionDueAt: string | null;
  practiceAttempts: number;
  openDisputes: number;
} & (
  | { status: "not_assessed" | "practicing" | "disputed"; gateId: null }
  | {
      status: Exclude<MemorySkillStatus, "not_assessed">;
      gateId: string;
      basis: "current_course_independent_gate_evidence";
      independentFamilies: number;
      requiredFamilies: number;
      familiesTruncated: boolean;
      evidenceRefsTruncated: boolean;
    }
);
export interface MemoryScope {
  enrollmentId: string;
  courseDigest: string;
  episodeId: string;
  workspaceId?: string;
}
export interface MemorySnapshot {
  enrollmentId: string;
  workspaceId: string;
  courseDigest: string;
  revision: number;
  profileRevision: number;
  modelRevision: number;
  scope: {
    episodeId: string;
    objectiveIds: string[];
    objectivesTruncated: boolean;
  };
  understanding: MemoryUnderstanding[];
  selfReport: MemoryProfile & { trust: "learner_statement_not_evidence" };
  suggestions: { items: MemoryProposal[]; truncated: boolean };
}
export type MemoryDecision =
  | { action: "accept" | "dispute"; reason?: string }
  | { action: "correct"; correction: MemorySuggestion; reason?: string };
export interface MemoryReceipt {
  changeId: string;
  eventId: string;
  revision: number;
  modelRevision: number;
  proposalId: string | null;
  grantsMastery: false;
}
export type MemoryHistoryKind = "all" | "questions" | "evidence";
export type MemoryHistoryItem = {
  cursor: string;
  eventId: string;
  text: string;
} & (
  | { kind: "questions"; messageId: string }
  | {
      kind: "evidence";
      attemptId: string;
      assessmentId: string;
      passed: boolean;
      mode: string;
      evidenceRefs: {
        evidenceId: string;
        objectiveId: string;
        independent: boolean;
        invalidated: boolean;
        disputed?: boolean;
        excluded?: boolean;
      }[];
      evidenceRefsTruncated: boolean;
    }
);
export interface MemoryHistory {
  scope: MemorySnapshot["scope"];
  items: MemoryHistoryItem[];
  nextCursor: string | null;
  scannedEvents: number;
  maxScannedEvents: number;
  maxSearchedTextCharacters: number;
  maxSnippetCharacters: number;
}
/** The learner's own controls over one piece of their evidence. */
export type EvidenceControlAction =
  | "dispute"
  | "withdraw_dispute"
  | "exclude"
  | "include";
export interface EvidenceControlReceipt {
  evidenceId: string;
  action: EvidenceControlAction;
  eventId: string;
  revision: number;
  disputed: boolean;
  excluded: boolean;
  grantsMastery: false;
  changesCredit: false;
}
export interface MemoryChange {
  cursor: string;
  id: string;
  modelRevision: number;
  actorKind: "learner" | "agent";
  action:
    | "profile.edited"
    | "proposal.created"
    | "proposal.accepted"
    | "proposal.corrected"
    | "proposal.disputed"
    | "proposal.source_revoked";
  proposalId: string | null;
  eventId: string;
  createdAt: string;
  data: {
    profile?: MemoryProfile;
    suggestion?: MemorySuggestion;
    originalSuggestion?: MemorySuggestion;
    correction?: MemorySuggestion;
    reason?: string;
    sourceEventRefs?: MemorySource[];
  };
}
export interface MemoryChanges {
  items: MemoryChange[];
  nextCursor: string | null;
}
export interface LearnerMemoryClient {
  /** Compose once per authenticated account; replace on sign-out/account change. */
  readonly accountId: string;
  load(scope: MemoryScope, signal?: AbortSignal): Promise<MemorySnapshot>;
  save(
    scope: MemoryScope,
    revision: number,
    profile: MemoryProfile,
  ): Promise<MemoryReceipt>;
  decide(
    scope: MemoryScope,
    revision: number,
    proposalId: string,
    decision: MemoryDecision,
  ): Promise<MemoryReceipt>;
  pending(scope: MemoryScope): "profile" | "decision" | null;
  retry(scope: MemoryScope): Promise<MemoryReceipt>;
  history(
    scope: MemoryScope,
    query: { q: string; kind: MemoryHistoryKind; before?: string },
    signal?: AbortSignal,
  ): Promise<MemoryHistory>;
  changes(
    scope: MemoryScope,
    before?: string,
    signal?: AbortSignal,
  ): Promise<MemoryChanges>;
  /** Dispute, withdraw a dispute, exclude from AI context or include again.
   * Never changes credit. Not retained for retry: refresh after a failure. */
  controlEvidence(
    scope: MemoryScope,
    revision: number,
    evidenceId: string,
    action: EvidenceControlAction,
    reason?: string,
  ): Promise<EvidenceControlReceipt>;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 128): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const boundedText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max;
const number = (v: unknown, max = 2147483647): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const digest = (v: unknown) =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const cursor = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[1-9][0-9]{0,18}$/.test(v) &&
  BigInt(v) <= 9223372036854775807n;
const list = (
  v: unknown,
  max: number,
  check: (v: unknown) => boolean,
): v is unknown[] =>
  Array.isArray(v) && v.length <= max && v.every((item) => check(item));
const pace = (v: unknown) =>
  ["gentle", "steady", "focused"].includes(String(v));
const style = (v: unknown) =>
  ["concise", "step_by_step", "worked_example"].includes(String(v));
function profile(v: unknown): boolean {
  return (
    object(v) &&
    object(v.preferences) &&
    (v.preferences.pace === undefined || pace(v.preferences.pace)) &&
    (v.preferences.explanationStyle === undefined ||
      style(v.preferences.explanationStyle)) &&
    (v.preferences.goal === undefined ||
      boundedText(v.preferences.goal, 2000)) &&
    (v.preferences.languages === undefined ||
      (list(v.preferences.languages, 5, (l) => typeof l === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(l)) &&
        new Set(v.preferences.languages).size === v.preferences.languages.length)) &&
    (v.preferences.experience === undefined || (MEMORY_EXPERIENCE as readonly unknown[]).includes(v.preferences.experience)) &&
    (v.preferences.depth === undefined || (MEMORY_DEPTH as readonly unknown[]).includes(v.preferences.depth)) &&
    (v.preferences.weeklyMinutes === undefined ||
      (Number.isSafeInteger(v.preferences.weeklyMinutes) && (v.preferences.weeklyMinutes as number) >= 15 && (v.preferences.weeklyMinutes as number) <= 1200)) &&
    (v.preferences.accessibility === undefined ||
      (list(v.preferences.accessibility, 7, (a) => (MEMORY_ACCESSIBILITY as readonly unknown[]).includes(a)) &&
        new Set(v.preferences.accessibility).size === v.preferences.accessibility.length)) &&
    boundedText(v.thoughts, 1000) &&
    list(
      v.priorKnowledge,
      20,
      (r) =>
        object(r) &&
        text(r.objectiveId) &&
        text(r.statement, 500) &&
        r.statement.trim().length > 0,
    ) &&
    new Set(
      v.priorKnowledge.map((r) => (r as { objectiveId: string }).objectiveId),
    ).size === v.priorKnowledge.length
  );
}
function suggestion(v: unknown): boolean {
  return (
    object(v) &&
    (v.kind === "pace"
      ? pace(v.value)
      : v.kind === "explanation_style"
        ? style(v.value)
        : v.kind === "review_objective" && text(v.objectiveId))
  );
}
const source = (v: unknown) =>
  object(v) &&
  text(v.eventId) &&
  cursor(v.cursor) &&
  text(v.eventType) &&
  digest(v.digest);
const optionalFlag = (v: unknown) => v === undefined || typeof v === "boolean";
function assertResponse(value: unknown): asserts value {
  if (!value) throw new CourseApiError("INVALID_RESPONSE", 502);
}
function assertInput(value: unknown): asserts value {
  if (!value) throw new CourseApiError("INVALID_REQUEST", 400);
}
function scoped(v: unknown, scope: MemoryScope): v is MemorySnapshot["scope"] {
  return (
    object(v) &&
    v.episodeId === scope.episodeId &&
    list(v.objectiveIds, 20, text) &&
    typeof v.objectivesTruncated === "boolean"
  );
}
export function parseMemorySnapshot(
  value: unknown,
  scope: MemoryScope,
): MemorySnapshot {
  assertResponse(
    object(value) &&
      value.enrollmentId === scope.enrollmentId &&
      digest(value.courseDigest) &&
      value.courseDigest === scope.courseDigest &&
      text(value.workspaceId) &&
      (!scope.workspaceId || value.workspaceId === scope.workspaceId) &&
      scoped(value.scope, scope) &&
      number(value.revision) &&
      value.revision > 0 &&
      number(value.profileRevision) &&
      number(value.modelRevision) &&
      object(value.selfReport) &&
      value.selfReport.trust === "learner_statement_not_evidence" &&
      profile(value.selfReport) &&
      list(value.understanding, 20, (row) => {
        if (
          !object(row) ||
          !text(row.objectiveId) ||
          !list(
            row.evidenceRefs,
            20,
            (ref) =>
              object(ref) &&
              text(ref.evidenceId) &&
              text(ref.attemptId) &&
              ref.courseDigest === scope.courseDigest &&
              optionalFlag(ref.disputed) &&
              optionalFlag(ref.excluded) &&
              (ref.evaluator === undefined || text(ref.evaluator)) &&
              (ref.decidedBy === undefined || ["automatic_check", "staff_review", "second_opinion", "staff_regrade"].includes(String(ref.decidedBy))) &&
              (ref.recordedAt === undefined || (typeof ref.recordedAt === "string" && Number.isFinite(Date.parse(ref.recordedAt)))),
          )
        )
          return false;
        if (
          !(row.explanation === undefined || text(row.explanation, 500)) ||
          typeof row.demonstrated !== "boolean" ||
          !["not_scheduled", "scheduled", "retained", "needs_review"].includes(
            String(row.retention),
          ) ||
          !(row.retentionDueAt === null || text(row.retentionDueAt, 100)) ||
          !number(row.practiceAttempts) ||
          !number(row.openDisputes) ||
          (row.status === "disputed") !== row.openDisputes > 0
        )
          return false;
        if (row.gateId === null)
          return (
            ["not_assessed", "practicing", "disputed"].includes(
              String(row.status),
            ) &&
            row.demonstrated === false &&
            row.evidenceRefs.length === 0
          );
        return (
          [
            "needs_evidence",
            "practicing",
            "demonstrated",
            "retained",
            "needs_review",
            "disputed",
          ].includes(String(row.status)) &&
          text(row.gateId) &&
          row.basis === "current_course_independent_gate_evidence" &&
          number(row.independentFamilies, 100) &&
          number(row.requiredFamilies, 100) &&
          row.requiredFamilies > 0 &&
          row.demonstrated === row.independentFamilies >= row.requiredFamilies &&
          (!["demonstrated", "retained", "needs_review"].includes(
            String(row.status),
          ) ||
            row.demonstrated) &&
          typeof row.familiesTruncated === "boolean" &&
          typeof row.evidenceRefsTruncated === "boolean"
        );
      }) &&
      object(value.suggestions) &&
      typeof value.suggestions.truncated === "boolean" &&
      list(
        value.suggestions.items,
        20,
        (p) =>
          object(p) &&
          text(p.proposalId) &&
          (p.origin === undefined ||
            (object(p.origin) &&
              (p.origin.kind === "course_ai" ||
                (p.origin.kind === "connected_agent" &&
                  text(p.origin.grantId) &&
                  (p.origin.label === null || typeof p.origin.label === "string"))))) &&
          ["pending", "accepted", "corrected", "disputed", "source_revoked", "expired"].includes(
            String(p.status),
          ) &&
          (p.uncertainty === undefined || p.uncertainty === null || ["low", "medium", "high"].includes(String(p.uncertainty))) &&
          (p.expiresAt === undefined || p.expiresAt === null || (typeof p.expiresAt === "string" && !Number.isNaN(Date.parse(p.expiresAt)))) &&
          suggestion(p.suggestion) &&
          suggestion(p.originalSuggestion) &&
          (p.decisionId === null || text(p.decisionId)) &&
          p.grantsMastery === false &&
          list(p.sourceEventRefs, 8, source) &&
          p.sourceEventRefs.length > 0,
      ),
  );
  const result = value as unknown as MemorySnapshot;
  assertResponse(
    result.understanding.length === result.scope.objectiveIds.length &&
      new Set(result.understanding.map((row) => row.objectiveId)).size ===
        result.understanding.length &&
      result.understanding.every((row) =>
        result.scope.objectiveIds.includes(row.objectiveId),
      ),
  );
  return result;
}
function parseReceipt(
  value: unknown,
  proposalId: string | null,
  expectedRevision: number,
): MemoryReceipt {
  assertResponse(
    object(value) &&
      text(value.changeId) &&
      text(value.eventId) &&
      number(value.revision) &&
      value.revision === expectedRevision + 1 &&
      number(value.modelRevision) &&
      value.modelRevision > 0 &&
      value.proposalId === proposalId &&
      value.grantsMastery === false,
  );
  return value as unknown as MemoryReceipt;
}
function parseHistory(
  value: unknown,
  scope: MemoryScope,
  before?: string,
): MemoryHistory {
  assertResponse(
    object(value) &&
      scoped(value.scope, scope) &&
      number(value.scannedEvents, 200) &&
      value.maxScannedEvents === 200 &&
      value.maxSearchedTextCharacters === 4000 &&
      value.maxSnippetCharacters === 1000 &&
      (value.nextCursor === null ||
        (cursor(value.nextCursor) &&
          (!before || BigInt(value.nextCursor) < BigInt(before)))) &&
      list(
        value.items,
        10,
        (row) =>
          object(row) &&
          cursor(row.cursor) &&
          (!before || BigInt(row.cursor) < BigInt(before)) &&
          text(row.eventId) &&
          boundedText(row.text, 1000) &&
          (row.kind === "questions"
            ? text(row.messageId)
            : row.kind === "evidence" &&
              text(row.attemptId) &&
              text(row.assessmentId) &&
              typeof row.passed === "boolean" &&
              ["practice", "placement", "independent"].includes(
                String(row.mode),
              ) &&
              typeof row.evidenceRefsTruncated === "boolean" &&
              list(
                row.evidenceRefs,
                20,
                (ref) =>
                  object(ref) &&
                  text(ref.evidenceId) &&
                  text(ref.objectiveId) &&
                  typeof ref.independent === "boolean" &&
                  typeof ref.invalidated === "boolean" &&
                  optionalFlag(ref.disputed) &&
                  optionalFlag(ref.excluded),
              )),
      ),
  );
  return value as unknown as MemoryHistory;
}
function parseChanges(value: unknown, before?: string): MemoryChanges {
  assertResponse(
    object(value) &&
      (value.nextCursor === null ||
        (cursor(value.nextCursor) &&
          (!before || BigInt(value.nextCursor) < BigInt(before)))) &&
      list(value.items, 10, (row) => {
        if (
          !object(row) ||
          !cursor(row.cursor) ||
          (before && BigInt(row.cursor) >= BigInt(before)) ||
          !text(row.id) ||
          !text(row.eventId) ||
          !number(row.modelRevision) ||
          !["learner", "agent"].includes(String(row.actorKind)) ||
          !text(row.createdAt, 100) ||
          !Number.isFinite(Date.parse(row.createdAt)) ||
          !(row.proposalId === null || text(row.proposalId)) ||
          !object(row.data)
        )
          return false;
        const data = row.data;
        if (row.action === "profile.edited") return profile(data.profile);
        if (row.action === "proposal.created")
          return (
            suggestion(data.suggestion) && list(data.sourceEventRefs, 8, source)
          );
        return (
          [
            "proposal.accepted",
            "proposal.corrected",
            "proposal.disputed",
            "proposal.source_revoked",
          ].includes(String(row.action)) &&
          suggestion(data.originalSuggestion) &&
          (row.action !== "proposal.corrected" ||
            suggestion(data.correction)) &&
          boundedText(data.reason, 500)
        );
      }),
  );
  return value as unknown as MemoryChanges;
}

/** Use the account's existing createCourseApi transport: it supplies cookies,
 * CSRF, no-store and redirect rejection. Its generic command() does not support
 * these hyphenated/UUID routes. This port retains exact unconfirmed payloads in
 * memory, never localStorage, and must be kept alive while the account is active.
 * It exposes no proposal creation/agent-authority endpoint. */
export function createMemoryClient(
  api: Pick<CourseApi, "request" | "hasPending">,
  accountId: string,
): LearnerMemoryClient {
  assertInput(text(accountId));
  type Pending = {
    kind: "profile" | "decision";
    path: string;
    semantic: string;
    body: Record<string, unknown>;
    proposalId: string | null;
    flight?: Promise<MemoryReceipt>;
  };
  const pending = new Map<string, Pending>();
  const base = (scope: MemoryScope) =>
    `/api/enrollments/${encodeURIComponent(scope.enrollmentId)}/learner-model`;
  const key = (scope: MemoryScope) =>
    JSON.stringify([accountId, scope.enrollmentId]);
  function send(scope: MemoryScope, request: Pending): Promise<MemoryReceipt> {
    if (request.flight) return request.flight;
    request.flight = (async () => {
      try {
        const result = parseReceipt(
          await api.request(request.path, "POST", request.body),
          request.proposalId,
          request.body.expectedRevision as number,
        );
        pending.delete(key(scope));
        return result;
      } catch (error) {
        if (
          error instanceof CourseApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 429].includes(error.status)
        )
          pending.delete(key(scope));
        throw error;
      } finally {
        request.flight = undefined;
      }
    })();
    return request.flight;
  }
  function mutate(
    scope: MemoryScope,
    revision: number,
    kind: Pending["kind"],
    path: string,
    body: Record<string, unknown>,
    proposalId: string | null,
  ) {
    assertInput(number(revision) && revision > 0);
    // Freeze intent before sending; later edits must never mutate a retained retry.
    const semantic = JSON.stringify({
      courseDigest: scope.courseDigest,
      path,
      body,
    });
    const previous = pending.get(key(scope));
    if (previous && previous.semantic !== semantic)
      throw new CourseApiError("PENDING_UNCERTAIN", 0);
    if (!previous && api.hasPending(scope.enrollmentId))
      throw new CourseApiError("PENDING_UNCERTAIN", 0);
    const request = previous ?? {
      kind,
      path,
      semantic,
      proposalId,
      body: {
        ...JSON.parse(JSON.stringify(body)),
        expectedRevision: revision,
        idempotencyKey: randomId(),
      },
    };
    pending.set(key(scope), request);
    return send(scope, request);
  }
  return {
    accountId,
    pending: (scope) => pending.get(key(scope))?.kind ?? null,
    async retry(scope) {
      const request = pending.get(key(scope));
      if (!request) throw new CourseApiError("NO_PENDING_MEMORY_CHANGE", 409);
      return send(scope, request);
    },
    async load(scope, signal) {
      return parseMemorySnapshot(
        await api.request(
          `${base(scope)}?${new URLSearchParams({ episodeId: scope.episodeId })}`,
          "GET",
          undefined,
          { signal },
        ),
        scope,
      );
    },
    async save(scope, revision, value) {
      assertInput(profile(value));
      // Exclude the snapshot's trust marker and any UI-only fields from strict API bodies.
      const clean: MemoryProfile = {
        preferences: { ...value.preferences },
        priorKnowledge: value.priorKnowledge.map((row) => ({ ...row })),
        thoughts: value.thoughts,
      };
      return mutate(
        scope,
        revision,
        "profile",
        `${base(scope)}/profile`,
        { profile: clean },
        null,
      );
    },
    async decide(scope, revision, proposalId, decision) {
      assertInput(
        text(proposalId) &&
          ["accept", "correct", "dispute"].includes(decision.action) &&
          (decision.reason === undefined ||
            boundedText(decision.reason, 500)) &&
          (decision.action !== "correct" || suggestion(decision.correction)),
      );
      return mutate(
        scope,
        revision,
        "decision",
        `${base(scope)}/proposals/${encodeURIComponent(proposalId)}/decision`,
        { ...decision },
        proposalId,
      );
    },
    async history(scope, query, signal) {
      assertInput(
        boundedText(query.q, 100) &&
          ["all", "questions", "evidence"].includes(query.kind) &&
          (!query.before || cursor(query.before)),
      );
      const params = new URLSearchParams({
        episodeId: scope.episodeId,
        q: query.q.trim(),
        kind: query.kind,
        limit: "10",
      });
      if (query.before) params.set("before", query.before);
      return parseHistory(
        await api.request(
          `${base(scope)}/history?${params}`,
          "GET",
          undefined,
          { signal },
        ),
        scope,
        query.before,
      );
    },
    async controlEvidence(scope, revision, evidenceId, action, reason) {
      assertInput(
        number(revision) &&
          revision > 0 &&
          text(evidenceId) &&
          ["dispute", "withdraw_dispute", "exclude", "include"].includes(
            action,
          ) &&
          (action === "dispute"
            ? text(reason?.trim(), 500)
            : reason === undefined),
      );
      const value = await api.request(
        `${base(scope)}/evidence/${encodeURIComponent(evidenceId)}/control`,
        "POST",
        {
          expectedRevision: revision,
          idempotencyKey: randomId(),
          action,
          ...(action === "dispute" ? { reason: reason!.trim() } : {}),
        },
      );
      assertResponse(
        object(value) &&
          value.evidenceId === evidenceId &&
          value.action === action &&
          text(value.eventId) &&
          number(value.revision) &&
          value.revision === revision + 1 &&
          typeof value.disputed === "boolean" &&
          typeof value.excluded === "boolean" &&
          value.grantsMastery === false &&
          value.changesCredit === false,
      );
      return value as unknown as EvidenceControlReceipt;
    },
    async changes(scope, before, signal) {
      assertInput(!before || cursor(before));
      const params = new URLSearchParams({ limit: "10" });
      if (before) params.set("before", before);
      return parseChanges(
        await api.request(
          `${base(scope)}/changes?${params}`,
          "GET",
          undefined,
          { signal },
        ),
        before,
      );
    },
  };
}
