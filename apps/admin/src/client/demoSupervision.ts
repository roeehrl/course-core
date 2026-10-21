// i18n-ignore-file: fictional demo requests written by a learner and a staff member, like src/data/
import type { DemoRole } from "../data/fixtures";
import {
  SupervisionError,
  type AuthorityRequest,
  type AutonomyLevel,
  type LearnerBudget,
  type SettingsPreview,
  type SupervisionAction,
  type SupervisionOverview,
  type SupervisionPort,
  type SupervisionResult,
  type SupervisionSettings,
  type SupervisionSettingsPort,
} from "../domain/supervision";
import type { DemoScenario } from "./demoClient";

/** Fictional ids: the demo has no server, so every record here is invented. */
const uuid = (prefix: string, n: number) =>
  `00000000-0000-4000-8${prefix.padStart(3, "0")}-${String(n).padStart(12, "0")}`;
const LEVELS: AutonomyLevel[] = [
  "recommend_only",
  "propose_only",
  "apply_verified_personal",
];
/** The host's tool families and a representative subset of their tools. */
const FAMILIES: { id: string; tools: [string, string][] }[] = [
  {
    id: "learner_read",
    tools: [
      ["get_history", "none"],
      ["get_profile", "none"],
      ["get_evidence", "none"],
    ],
  },
  {
    id: "teaching",
    tools: [
      ["list_sources", "none"],
      ["choose_support", "proposal_only"],
      ["create_teaching", "artifact_write"],
    ],
  },
  {
    id: "research",
    tools: [
      ["list_research_topics", "none"],
      ["request_research", "proposal_only"],
    ],
  },
  {
    id: "learner_model",
    tools: [
      ["get_model_sources", "none"],
      ["suggest_model", "proposal_only"],
    ],
  },
  {
    id: "hypothesis",
    tools: [
      ["list_hypotheses", "none"],
      ["propose_hypothesis", "proposal_only"],
    ],
  },
  {
    id: "assessment",
    tools: [
      ["get_assessment_outline", "none"],
      ["propose_practice_check", "proposal_only"],
    ],
  },
  { id: "code_lab", tools: [["get_code_results", "none"]] },
  {
    id: "visual_media",
    tools: [
      ["list_visuals", "none"],
      ["choose_visual", "proposal_only"],
    ],
  },
  {
    id: "delegation",
    tools: [
      ["compare_alternatives", "none"],
      ["choose_alternative", "proposal_only"],
    ],
  },
];
const EFFECTS: Record<AutonomyLevel, string[]> = {
  recommend_only: [
    "records_recommendations_only",
    "no_new_teaching_actions",
    "scheduled_follow_ups_end",
  ],
  propose_only: [
    "starts_teaching_actions",
    "teaching_changes_refused",
    "learner_reviewed_proposals_continue",
  ],
  apply_verified_personal: [
    "starts_teaching_actions",
    "verified_personal_changes_apply",
    "learner_can_undo",
  ],
};
const tools = (families: string[]) =>
  FAMILIES.filter((f) => families.includes(f.id)).flatMap((f) =>
    f.tools.map(([id]) => id),
  );
const TARGET: Record<
  SupervisionAction,
  SupervisionOverview["control"]["state"]
> = { pause: "paused", stop: "stopped", resume: "active" };

type Learner = { id: string; name: string };
type EnrollmentState = {
  overview: SupervisionOverview;
  receipts: Map<
    string,
    { action: SupervisionAction; result: SupervisionResult }
  >;
  requeues: Map<string, string>;
  budget: LearnerBudget;
};

/**
 * In-memory AI supervision for the demo: per-learner pause, stop and resume, undelivered
 * requests (one re-queueable), workspace autonomy settings, authority requests and spending
 * limits. Fictional data only; nothing reaches a supervisor or a provider.
 */
export function createDemoSupervision({
  role = "administrator",
  scenario = "standard",
  latency = 140,
  learners,
  now = () => new Date().toISOString(),
}: {
  role?: DemoRole;
  scenario?: DemoScenario;
  latency?: number;
  /** The demo enrollments supervision can be opened for, by id, with a display name. */
  learners: Learner[];
  now?: () => string;
}): SupervisionPort &
  Required<Pick<SupervisionPort, "requeue">> & {
    settings: SupervisionSettingsPort;
  } {
  const canControl = role === "administrator";
  const clone = <T>(value: T): T => structuredClone(value);
  let staleOnce = scenario === "stale_revision";
  const enrollments = new Map<string, EnrollmentState>();
  learners.forEach((learner, index) => {
    const n = index + 1;
    enrollments.set(learner.id, {
      overview: {
        control: {
          state: "active",
          revision: 0,
          reasonCode: null,
          changedBy: null,
          changedAt: null,
        },
        jobs: [
          {
            id: uuid("a", n * 10 + 1),
            role: "supervisor",
            state: "waiting",
            reason: null,
            held: false,
            cancellationRequested: false,
            createdAt: "2026-10-12T09:40:00.000Z",
          },
          {
            id: uuid("a", n * 10 + 2),
            role: "research",
            state: "budget_wait",
            reason: null,
            held: false,
            cancellationRequested: false,
            createdAt: "2026-10-12T09:35:00.000Z",
          },
        ],
        pendingSignals: 0,
        undeliveredEvents: [
          {
            eventId: uuid("b", n * 10 + 1),
            eventType: "assessment.submitted",
            outcome: "quarantined",
            reason: "delivery_failed",
            at: "2026-10-11T16:20:00.000Z",
            requeued: false,
            requeueable: canControl,
          },
        ],
        canControl,
        canRequeue: canControl,
      },
      receipts: new Map(),
      requeues: new Map(),
      budget: {
        enrollmentId: uuid("c", n),
        overall: { microUsd: 5_000_000, tokens: 2_000_000 },
        daily: { microUsd: 500_000, tokens: 200_000 },
        artifact: null,
        usedToday: { microUsd: 42_000, tokens: 18_500 },
        usedInCurrentLessonToday: { microUsd: 12_000, tokens: 5_200 },
        currentEpisodeId: "ep-1",
        dayBoundary: "utc",
      },
    });
  });
  let settings: SupervisionSettings = {
    autonomyLevel: "propose_only",
    permittedToolFamilies: [
      "learner_read",
      "teaching",
      "research",
      "assessment",
      "visual_media",
    ],
    conversationConfirmation: "as_authored",
    revision: 3,
    levels: [...LEVELS],
    families: FAMILIES.map((f) => ({
      id: f.id,
      tools: f.tools.map(([id, sideEffects]) => ({ id, sideEffects })),
    })),
  };
  const requests: AuthorityRequest[] = [
    {
      requestId: uuid("d", 1),
      jobId: uuid("a", 11),
      kind: "paid_ceiling",
      approver: "staff",
      proposal: { limitMicroUsd: 2_000_000 },
      reason: "A longer worked example would exceed today's limit.",
      state: "pending",
      decidedAt: null,
      createdAt: "2026-10-12T09:41:00.000Z",
      ...(learners[0]
        ? { enrollmentId: uuid("c", 1), learnerName: learners[0].name }
        : {}),
    },
    {
      requestId: uuid("d", 2),
      jobId: uuid("a", 21),
      kind: "goal_change",
      approver: "learner",
      proposal: { goal: "Practise insertion sort on short lists first." },
      reason: null,
      state: "approved",
      decidedAt: "2026-10-11T12:00:00.000Z",
      createdAt: "2026-10-11T11:30:00.000Z",
      ...(learners[1]
        ? { enrollmentId: uuid("c", 2), learnerName: learners[1].name }
        : {}),
    },
  ];
  const decisions = new Map<string, string>();

  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (latency)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, latency);
        signal?.addEventListener("abort", abort, { once: true });
      });
    if (scenario === "permission_denied")
      throw new SupervisionError("FORBIDDEN");
    if (scenario === "load_failure") throw new SupervisionError("unavailable");
  }
  function enrollment(id: string) {
    const state = enrollments.get(id);
    if (!state) throw new SupervisionError("SUPERVISOR_NOT_FOUND");
    return state;
  }
  function staff(admin = true) {
    if (admin ? role !== "administrator" : role === "observer")
      throw new SupervisionError("FORBIDDEN");
  }
  const validLimit = (l: { microUsd: number; tokens: number } | null) =>
    l === null ||
    (Number.isSafeInteger(l.microUsd) &&
      Number.isSafeInteger(l.tokens) &&
      l.microUsd >= 0 &&
      l.tokens >= 0);

  const settingsPort: SupervisionSettingsPort = {
    async load(_workspaceId, signal) {
      await delay(signal);
      staff();
      return clone(settings);
    },
    async preview(_workspaceId, input): Promise<SettingsPreview> {
      await delay();
      staff();
      if (!LEVELS.includes(input.autonomyLevel))
        throw new SupervisionError("INVALID_REQUEST");
      const before = new Set(tools(settings.permittedToolFamilies));
      const after = new Set(tools(input.permittedToolFamilies));
      return {
        autonomyLevel: input.autonomyLevel,
        effects: [...EFFECTS[input.autonomyLevel]],
        toolsAdded: [...after].filter((t) => !before.has(t)),
        toolsRemoved: [...before].filter((t) => !after.has(t)),
        warnings: [
          ...(after.size === 0 ? ["no_tools"] : []),
          ...(input.permittedToolFamilies.includes("learner_read")
            ? []
            : ["no_learner_read"]),
        ],
        optedInLearners: learners.length,
        openTeachingActions: 1,
        confirmation:
          (input.conversationConfirmation ??
            settings.conversationConfirmation) === "people_only"
            ? "people_confirm_every_conversation"
            : "checkpoints_as_authored",
        waitingConversations: 2,
      };
    },
    async save(_workspaceId, input) {
      await delay();
      staff();
      if (input.expectedRevision !== settings.revision)
        throw new SupervisionError("SUPERVISION_SETTINGS_CHANGED");
      const known = new Set(FAMILIES.map((f) => f.id));
      if (
        !LEVELS.includes(input.autonomyLevel) ||
        input.permittedToolFamilies.some((f) => !known.has(f))
      )
        throw new SupervisionError("INVALID_REQUEST");
      settings = {
        ...settings,
        autonomyLevel: input.autonomyLevel,
        permittedToolFamilies: FAMILIES.map((f) => f.id).filter((f) =>
          input.permittedToolFamilies.includes(f),
        ),
        conversationConfirmation:
          input.conversationConfirmation ?? settings.conversationConfirmation,
        revision: settings.revision + 1,
      };
      return clone(settings);
    },
    async requests(_workspaceId, signal) {
      await delay(signal);
      staff();
      return clone({ requests });
    },
    async decide(_workspaceId, requestId, input) {
      await delay();
      staff();
      const request = requests.find((r) => r.requestId === requestId);
      if (!request) throw new SupervisionError("AUTHORITY_REQUEST_NOT_FOUND");
      const replay = decisions.get(input.idempotencyKey);
      if (replay !== undefined) {
        if (replay !== `${requestId}:${input.decision}`)
          throw new SupervisionError("IDEMPOTENCY_CONFLICT");
        return clone(request);
      }
      if (request.approver === "learner")
        throw new SupervisionError("AUTHORITY_DECIDED_BY_LEARNER");
      if (request.state !== "pending")
        throw new SupervisionError("AUTHORITY_REQUEST_CLOSED");
      request.state = input.decision === "approve" ? "approved" : "rejected";
      request.decidedAt = now();
      decisions.set(input.idempotencyKey, `${requestId}:${input.decision}`);
      return clone(request);
    },
    async budget(_workspaceId, enrollmentId, signal) {
      await delay(signal);
      staff();
      return clone(enrollment(enrollmentId).budget);
    },
    async saveBudget(_workspaceId, enrollmentId, input) {
      await delay();
      staff();
      const state = enrollment(enrollmentId);
      if (!validLimit(input.daily) || !validLimit(input.artifact))
        throw new SupervisionError("INVALID_REQUEST");
      if (
        input.daily &&
        input.artifact &&
        (input.artifact.microUsd > input.daily.microUsd ||
          input.artifact.tokens > input.daily.tokens)
      )
        throw new SupervisionError("SUPERVISION_LESSON_LIMIT_ABOVE_DAILY");
      state.budget = {
        ...state.budget,
        daily: input.daily && { ...input.daily },
        artifact: input.artifact && { ...input.artifact },
      };
      return clone(state.budget);
    },
  };

  return {
    async overview(enrollmentId, signal) {
      await delay(signal);
      staff(false);
      return clone(enrollment(enrollmentId).overview);
    },
    async control(enrollmentId, action, input) {
      await delay();
      staff();
      const state = enrollment(enrollmentId);
      const control = state.overview.control;
      const prior = state.receipts.get(input.idempotencyKey);
      if (prior) {
        if (prior.action !== action)
          throw new SupervisionError("IDEMPOTENCY_CONFLICT");
        return { ...clone(prior.result), replayed: true };
      }
      if (staleOnce) {
        staleOnce = false;
        control.revision += 1;
        throw new SupervisionError("SUPERVISION_CONTROL_STALE");
      }
      if (input.expectedRevision !== control.revision)
        throw new SupervisionError("SUPERVISION_CONTROL_STALE");
      // A stop is undone only by an explicit resume, never weakened to a pause.
      if (control.state === "stopped" && action === "pause")
        throw new SupervisionError("SUPERVISION_CONTROL_INVALID");
      const target = TARGET[action];
      if (target === control.state)
        return {
          state: target,
          previousState: target,
          revision: control.revision,
          changed: false,
          replayed: false,
          cancelledJobs: 0,
          signalledJobs: 0,
        };
      const live = state.overview.jobs;
      const result: SupervisionResult = {
        state: target,
        previousState: control.state,
        revision: control.revision + 1,
        changed: true,
        replayed: false,
        cancelledJobs:
          action === "stop"
            ? live.filter((j) => !j.cancellationRequested).length
            : 0,
        signalledJobs: live.length,
      };
      for (const job of live) {
        job.held = target === "paused";
        if (action === "stop") job.cancellationRequested = true;
      }
      if (action === "resume")
        state.overview.jobs = live.filter((j) => !j.cancellationRequested);
      state.overview.control = {
        state: target,
        revision: result.revision,
        reasonCode: input.reasonCode ?? null,
        changedBy: uuid("e", 1),
        changedAt: now(),
      };
      state.receipts.set(input.idempotencyKey, {
        action,
        result: clone(result),
      });
      return clone(result);
    },
    async requeue(enrollmentId, eventId, input) {
      await delay();
      staff();
      const state = enrollment(enrollmentId);
      const event = state.overview.undeliveredEvents.find(
        (e) => e.eventId === eventId,
      );
      if (!event) throw new SupervisionError("SUPERVISOR_EVENT_NOT_FOUND");
      const replay = state.requeues.get(input.idempotencyKey);
      if (replay !== undefined) {
        if (replay !== eventId)
          throw new SupervisionError("IDEMPOTENCY_CONFLICT");
        return {
          eventId,
          eventType: event.eventType,
          previousCode: event.reason,
          previousAttempts: 5,
          replayed: true,
        };
      }
      if (input.reason.trim().length < 10)
        throw new SupervisionError("INVALID_REQUEST");
      if (event.requeued)
        throw new SupervisionError("SUPERVISOR_EVENT_ALREADY_REQUEUED");
      if (event.outcome !== "quarantined")
        throw new SupervisionError("SUPERVISOR_EVENT_NOT_QUARANTINED");
      if (!event.requeueable)
        throw new SupervisionError("SUPERVISOR_EVENT_NOT_REQUEUEABLE");
      event.requeued = true;
      event.requeueable = false;
      state.requeues.set(input.idempotencyKey, eventId);
      return {
        eventId,
        eventType: event.eventType,
        previousCode: event.reason,
        previousAttempts: 5,
        replayed: false,
      };
    },
    settings: settingsPort,
  };
}
