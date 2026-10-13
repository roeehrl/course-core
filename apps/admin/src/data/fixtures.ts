import type {
  AdminSession,
  CourseWorkspace,
  Permission,
  SupervisorRun,
} from "../domain/contracts";

export const allPermissions: Permission[] = [
  "course.write",
  "release.review",
  "release.publish",
  "enrollment.write",
  "evidence.review",
  "extension.propose",
  "provider.configure",
  "run.inspect",
];
export type DemoRole = AdminSession["actor"]["role"];
export function demoSession(role: DemoRole): AdminSession {
  return {
    actor: { id: "demo-operator", name: "Demo operator", role },
    courses: [
      {
        id: "sorting",
        title: "Sorting, step by step",
        description:
          "A public example course about order, comparisons and small, useful algorithms.",
      },
      {
        id: "graphs",
        title: "A first look at graphs",
        description:
          "A public example course about nodes, edges and finding a path.",
      },
    ],
  };
}
export function demoWorkspace(
  summary: AdminSession["courses"][number],
  role: DemoRole,
): CourseWorkspace {
  const ref = summary.id;
  return {
    course: {
      ...summary,
      category: "Foundations",
      objectives: [
        "Understand the core idea",
        "Predict a small example",
        "Explain a result in your own words",
      ],
    },
    revision: "1",
    permissions:
      role === "administrator"
        ? [...allPermissions]
        : role === "reviewer"
          ? ["release.review", "evidence.review", "run.inspect"]
          : [],
    releases: [
      {
        id: `${ref}-draft`,
        version: "1.1.0",
        state: "draft",
        notes: "A clearer worked example and a short optional practice step.",
        createdAt: "2026-10-12T08:30:00Z",
        checks: [
          {
            label: "Bundle shape",
            passed: true,
            detail: "Demo schema check recorded.",
          },
          {
            label: "Evidence requirements",
            passed: true,
            detail: "Every required objective has an evidence rule.",
          },
          {
            label: "Public content",
            passed: true,
            detail: "Public sample content only.",
          },
        ],
      },
      {
        id: `${ref}-release`,
        version: "1.0.0",
        state: "published",
        availableForNewLearners: true,
        notes: "Initial public example. This is a fictional release record.",
        createdAt: "2026-10-10T09:00:00Z",
        checks: [],
      },
    ],
    enrollments: [
      {
        id: `${ref}-learner-01`,
        learnerRef: "example-learner-01",
        profile: {
          displayName: "Alex Example",
          goal: "Explain small ideas clearly.",
          pace: "steady",
        },
        releaseVersion: "1.0.0",
        status: "active",
        completed: 1,
        required: 3,
        evidence: [
          {
            id: "ev-01",
            objective: "Understand the core idea",
            summary: "A worked example met the sample rubric.",
            status: "accepted",
            version: "evidence-v1",
            rubricVersion: "rubric-v1",
            receiptId: "demo-receipt-01",
          },
          {
            id: "ev-02",
            objective: "Predict a small example",
            summary:
              "A learner explanation is waiting for an authorized reviewer.",
            status: "pending_review",
            version: "evidence-v2",
            rubricVersion: "rubric-v1",
            receiptId: null,
          },
          {
            id: "ev-03",
            objective: "Explain a result",
            summary:
              "This record belongs to an older rubric. New evidence is required.",
            status: "stale",
            version: "evidence-v0",
            rubricVersion: "rubric-v0",
            receiptId: null,
          },
        ],
      },
      {
        id: `${ref}-learner-02`,
        learnerRef: "example-learner-02",
        profile: {
          displayName: "Morgan Example",
          goal: "Build a regular learning habit.",
          pace: "gentle",
        },
        releaseVersion: "1.0.0",
        status: "paused",
        completed: 0,
        required: 3,
        evidence: [
          {
            id: "ev-04",
            objective: "Understand the core idea",
            summary: "The submitted example did not meet the sample rubric.",
            status: "rejected",
            version: "evidence-v1",
            rubricVersion: "rubric-v1",
            receiptId: "demo-receipt-02",
          },
        ],
      },
    ],
    providers: [
      {
        id: "text-provider",
        name: "Text & structured responses",
        description:
          "Provider slot for bounded explanations and structured assessment output.",
        capabilities: ["Text", "Structured output"],
        configuration: "absent",
        verification: "not_run",
        connectionLabel: "",
        environment: "",
        detail: "No connection configured. No provider request has been made.",
      },
      {
        id: "media-provider",
        name: "Media & learning assets",
        description:
          "Optional asset generation behind explicit policy and review.",
        capabilities: ["Images", "Artifact generation"],
        configuration: "absent",
        verification: "not_run",
        connectionLabel: "",
        environment: "",
        detail:
          "Optional capability. Provider credentials are managed on the server.",
      },
    ],
    runs: [
      {
        id: `${ref}-run-01`,
        label: "Optional practice proposal",
        status: "pending_review",
        startedAt: "2026-10-12T09:42:00Z",
        contextVersion: "context-v3",
        toolCalls: 0,
        artifactCount: 1,
      },
      {
        id: `${ref}-run-02`,
        label: "Provider readiness check",
        status: "blocked",
        startedAt: "2026-10-12T09:30:00Z",
        contextVersion: "context-v2",
        toolCalls: 0,
        artifactCount: 0,
      },
    ],
  };
}
export function demoRun(
  workspace: CourseWorkspace,
  runId: string,
): SupervisorRun | undefined {
  const summary = workspace.runs.find((run) => run.id === runId);
  if (!summary) return undefined;
  return {
    ...summary,
    summary:
      "Illustrative supervisor record. This fixture describes policy decisions and references; no model or provider was executed.",
    events: [
      {
        id: "event-01",
        time: "09:42:00",
        label: "Context pinned",
        status: "Recorded",
        detail:
          "Course release, policy revision and evidence references were bound to this sample run.",
      },
      {
        id: "event-02",
        time: "09:42:01",
        label: "Tool request held",
        status: "Blocked",
        detail:
          "Provider configuration is absent. No external call was executed.",
      },
      {
        id: "event-03",
        time: "09:42:02",
        label: "Review requested",
        status: "Pending review",
        detail:
          "The authored sample proposal is visible for review. It grants no learner credit.",
      },
    ],
    context: [
      {
        id: workspace.course.id,
        label: "Course release",
        version: "1.0.0",
        source: "Public demo bundle",
        visibility: "Reference only",
      },
      {
        id: "policy-ref",
        label: "Policy snapshot",
        version: "policy-v1",
        source: "Demo policy",
        visibility: "Bounded settings",
      },
      {
        id: "evidence-ref",
        label: "Evidence set",
        version: "evidence-v2",
        source: "Public fictional learner",
        visibility: "Redacted summary",
      },
    ],
    decisions: [
      {
        id: "decision-01",
        tool: "generate_practice",
        outcome: "denied",
        reasonCode: "PROVIDER_NOT_CONFIGURED",
        explanation:
          "An enabled and verified provider is required before this tool can run.",
        inputSummary:
          "Objective reference and a maximum of 2 practice units. No raw learner text included.",
        budgetUnits: 0,
      },
      {
        id: "decision-02",
        tool: "propose_calendar_extension",
        outcome: "pending_review",
        reasonCode: "EXACT_LEARNER_CONSENT_REQUIRED",
        explanation:
          "Staff may propose a calendar extension. Only the learner can accept its exact current terms digest.",
        inputSummary:
          "A scope-bound calendar extension proposal; no allowance debit or grant was made by this run.",
        budgetUnits: 0,
      },
    ],
    artifacts: summary.artifactCount
      ? [
          {
            id: "artifact-01",
            name: "Practice proposal",
            mediaType: "text/plain",
            status: "pending_review",
            preview:
              "Public demo artifact\n\nObjective: explain one small example.\nProposed limit: 5 minutes, 1 practice unit.\nStatus: awaiting review. No provider generated this text.",
            provenance: "Hand-authored demo fixture · artifact-v1",
          },
        ]
      : [],
  };
}
