import { CourseApiError, type CourseApi } from "./apiClient";

/** Teaching hypotheses about the signed-in learner: revisable guesses that guide
 * teaching. They are never grades or evidence; the server enforces that. */
export type HypothesisKind =
  | "misconception"
  | "missing_prerequisite"
  | "slip"
  | "ambiguous_item"
  | "useful_analogy";
export type HypothesisStatus =
  | "proposed"
  | "probing"
  | "confirmed"
  | "rejected"
  | "resolved"
  | "expired";
export interface HypothesisEvidenceRef {
  kind: "attempt" | "event" | "probe_run";
  id: string;
  supports: boolean;
  at: string;
}
export interface TeachingHypothesis {
  hypothesisId: string;
  revision: number;
  templateId: string | null;
  kind: HypothesisKind;
  statement: string;
  learnerCorrection: string | null;
  status: HypothesisStatus;
  uncertainty: "low" | "medium" | "high";
  source: "supervisor" | "companion" | "assessment" | "learner";
  pinned: boolean;
  rejectedBy: "learner" | "evidence" | "supervisor" | null;
  objectiveIds: string[];
  observations: number;
  evidenceRefs: HypothesisEvidenceRef[];
  evidenceRefsTruncated: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  probeAvailable: boolean;
  grantsMastery: false;
}
export type ProbeQuestion =
  | {
      id: string;
      type: "choice";
      prompt: string;
      options: { id: string; text: string }[];
    }
  | { id: string; type: "numeric"; prompt: string; unit?: string };
export interface ProbeRun {
  probeRunId: string;
  probeId: string;
  hypothesisIds: string[];
  requestedBy: "supervisor" | "learner" | "trigger";
  state: "scheduled" | "answered" | "abstained" | "expired" | "cancelled";
  question: ProbeQuestion | null;
  outcome: {
    outcome: "correct" | "incorrect" | "abstained";
    conclusive: boolean;
  } | null;
  scheduledAt: string;
  expiresAt: string;
  answeredAt: string | null;
  countsAsEvidence: false;
}
export interface HypothesisSnapshot {
  enrollmentId: string;
  courseDigest: string;
  revision: number;
  items: TeachingHypothesis[];
  probes: ProbeRun[];
  requests: {
    id: string;
    hypothesisId: string | null;
    objectiveId: string | null;
    state: "probe_scheduled" | "awaiting_supervisor" | "fulfilled";
    createdAt: string;
  }[];
  limits: {
    diagnosticRequestsPerDay: number;
    openProbes: number;
    probesPerDay: number;
    /** Open ideas allowed at once, and how long an unpinned idea is kept.
     * Absent from older servers. */
    activeIdeas?: number;
    ideaLifetimeDays?: number;
  };
  /** Whether answers and questions may suggest ideas on their own: the
   * learner's supervision opt-in. Absent from older servers. */
  automaticIdeas?: boolean;
  notEvidence: true;
}
export type HypothesisDecision =
  | { action: "pin" | "unpin" | "renew"; reason?: string }
  | { action: "reject"; reason?: string }
  | { action: "correct"; correction: string; reason?: string };
export type DiagnosticRequest =
  | { hypothesisId: string }
  | { objectiveId: string; note?: string };
export interface HypothesisReceipt {
  revision: number;
  eventId: string;
  grantsMastery: false;
}
export interface ProbeResult extends HypothesisReceipt {
  probeRunId: string;
  outcome: "correct" | "incorrect" | "abstained";
  correct: boolean | null;
  explanation: string | null;
  conclusive: boolean;
  hypotheses: {
    hypothesisId: string;
    status: HypothesisStatus;
    uncertainty: string;
    pinned: boolean;
    revision: number;
  }[];
  countsAsEvidence: false;
}
export interface HypothesisClient {
  readonly accountId: string;
  load(enrollmentId: string, signal?: AbortSignal): Promise<HypothesisSnapshot>;
  decide(
    snapshot: HypothesisSnapshot,
    hypothesis: TeachingHypothesis,
    decision: HypothesisDecision,
  ): Promise<HypothesisReceipt>;
  requestDiagnostic(
    snapshot: HypothesisSnapshot,
    request: DiagnosticRequest,
  ): Promise<HypothesisReceipt & { state: string; probeRunId: string | null }>;
  answerProbe(
    snapshot: HypothesisSnapshot,
    probeRunId: string,
    answer: { answer: string | number } | { abstain: true },
  ): Promise<ProbeResult>;
  /** The exact unconfirmed write, if a network failure left one. */
  pending(enrollmentId: string): boolean;
  retry(enrollmentId: string): Promise<HypothesisReceipt>;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const int = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const oneOf = (v: unknown, values: readonly string[]) =>
  typeof v === "string" && values.includes(v);
function check(value: unknown): asserts value {
  if (!value) throw new CourseApiError("INVALID_RESPONSE", 502);
}
function hypothesis(v: unknown): boolean {
  return (
    object(v) &&
    text(v.hypothesisId) &&
    int(v.revision) &&
    oneOf(v.kind, [
      "misconception",
      "missing_prerequisite",
      "slip",
      "ambiguous_item",
      "useful_analogy",
    ]) &&
    text(v.statement, 500) &&
    (v.learnerCorrection === null || text(v.learnerCorrection, 500)) &&
    oneOf(v.status, [
      "proposed",
      "probing",
      "confirmed",
      "rejected",
      "resolved",
      "expired",
    ]) &&
    oneOf(v.uncertainty, ["low", "medium", "high"]) &&
    oneOf(v.source, ["supervisor", "companion", "assessment", "learner"]) &&
    typeof v.pinned === "boolean" &&
    Array.isArray(v.objectiveIds) &&
    v.objectiveIds.every((o) => text(o)) &&
    int(v.observations) &&
    Array.isArray(v.evidenceRefs) &&
    typeof v.probeAvailable === "boolean" &&
    v.grantsMastery === false
  );
}
function probe(v: unknown): boolean {
  if (
    !object(v) ||
    !text(v.probeRunId) ||
    !oneOf(v.state, [
      "scheduled",
      "answered",
      "abstained",
      "expired",
      "cancelled",
    ]) ||
    v.countsAsEvidence !== false
  )
    return false;
  const q = v.question;
  if (q === null) return true;
  return (
    object(q) &&
    text(q.prompt, 4000) &&
    (q.type === "numeric" ||
      (q.type === "choice" &&
        Array.isArray(q.options) &&
        q.options.every((o) => object(o) && text(o.id) && text(o.text, 1000))))
  );
}
export function parseHypothesisSnapshot(
  value: unknown,
  enrollmentId: string,
): HypothesisSnapshot {
  check(
    object(value) &&
      value.enrollmentId === enrollmentId &&
      typeof value.courseDigest === "string" &&
      int(value.revision) &&
      Array.isArray(value.items) &&
      value.items.length <= 30 &&
      value.items.every(hypothesis) &&
      Array.isArray(value.probes) &&
      value.probes.every(probe) &&
      Array.isArray(value.requests) &&
      object(value.limits) &&
      (value.automaticIdeas === undefined || typeof value.automaticIdeas === "boolean") &&
      value.notEvidence === true,
  );
  return value as unknown as HypothesisSnapshot;
}
function receipt<T extends HypothesisReceipt>(value: unknown, expected: number) {
  check(
    object(value) &&
      int(value.revision) &&
      value.revision === expected + 1 &&
      text(value.eventId) &&
      value.grantsMastery === false,
  );
  return value as unknown as T;
}

/** Compose once per signed-in account, beside createMemoryClient. Unconfirmed
 * writes are kept in memory for exact retry and never in browser storage. */
export function createHypothesisClient(
  api: Pick<CourseApi, "request" | "hasPending">,
  accountId: string,
): HypothesisClient {
  const pending = new Map<
    string,
    { semantic: string; path: string; body: Record<string, unknown> }
  >();
  const base = (id: string) =>
    `/api/enrollments/${encodeURIComponent(id)}/learner-model`;
  async function send<T extends HypothesisReceipt>(
    enrollmentId: string,
    path: string,
    revision: number,
    data: Record<string, unknown>,
  ): Promise<T> {
    const semantic = JSON.stringify({ path, data });
    const previous = pending.get(enrollmentId);
    if (previous && previous.semantic !== semantic)
      throw new CourseApiError("PENDING_UNCERTAIN", 0);
    if (!previous && api.hasPending(enrollmentId))
      throw new CourseApiError("PENDING_UNCERTAIN", 0);
    const request = previous ?? {
      semantic,
      path,
      body: {
        ...data,
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
      },
    };
    pending.set(enrollmentId, request);
    try {
      const result = receipt<T>(
        await api.request(request.path, "POST", request.body),
        request.body.expectedRevision as number,
      );
      pending.delete(enrollmentId);
      return result;
    } catch (error) {
      if (
        error instanceof CourseApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status)
      )
        pending.delete(enrollmentId);
      throw error;
    }
  }
  return {
    accountId,
    pending: (enrollmentId) => pending.has(enrollmentId),
    async retry(enrollmentId) {
      const request = pending.get(enrollmentId);
      if (!request) throw new CourseApiError("NO_PENDING_CHANGE", 409);
      const data = JSON.parse(request.semantic).data;
      return send(
        enrollmentId,
        request.path,
        request.body.expectedRevision as number,
        data,
      );
    },
    async load(enrollmentId, signal) {
      return parseHypothesisSnapshot(
        await api.request(`${base(enrollmentId)}/hypotheses`, "GET", undefined, {
          signal,
        }),
        enrollmentId,
      );
    },
    decide(snapshot, h, decision) {
      return send(
        snapshot.enrollmentId,
        `${base(snapshot.enrollmentId)}/hypotheses/${encodeURIComponent(h.hypothesisId)}/decision`,
        snapshot.revision,
        { ...decision, expectedHypothesisRevision: h.revision },
      );
    },
    requestDiagnostic(snapshot, request) {
      return send(
        snapshot.enrollmentId,
        `${base(snapshot.enrollmentId)}/diagnostics`,
        snapshot.revision,
        { ...request },
      );
    },
    answerProbe(snapshot, probeRunId, answer) {
      return send(
        snapshot.enrollmentId,
        `${base(snapshot.enrollmentId)}/probes/${encodeURIComponent(probeRunId)}/answer`,
        snapshot.revision,
        { ...answer },
      );
    },
  };
}
