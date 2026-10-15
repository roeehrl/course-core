import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunsView } from "../src/views/RunsView";
import { TeachingHypothesesCard } from "../src/components/TeachingHypothesesCard";
import { createFetchAdminClient } from "../src/client/fetchClient";
import type { AdminClient, CourseWorkspace, Enrollment, SupervisorRun } from "../src/domain/contracts";
import type { HypothesisView } from "../src/domain/hypotheses";

const enrollment = { id: "8a632521-8f9a-4d37-884c-b7d2502a547e", learnerRef: "learner-1", profile: { displayName: "Synthetic learner", goal: "", pace: "steady" },
  releaseVersion: "1.0.0", status: "active", completed: 0, required: 2, evidence: [] } as unknown as Enrollment;
const view: HypothesisView = {
  enrollmentId: enrollment.id,
  items: [
    { hypothesisId: "h-1", revision: 3, templateId: "mix-up", kind: "misconception", statement: "May choose the largest value.", learnerCorrection: null,
      correctedByLearner: true, statementWithheld: false,
      status: "probing", uncertainty: "medium", source: "assessment", pinned: true, rejectedBy: null, objectiveIds: ["minimum"], observations: 2, updatedAt: "2026-10-14T00:00:00Z", grantsMastery: false },
    { hypothesisId: "h-2", revision: 1, templateId: null, kind: "misconception", statement: null, learnerCorrection: null, correctedByLearner: false, statementWithheld: true,
      status: "proposed", uncertainty: "high", source: "learner", pinned: false, rejectedBy: null, objectiveIds: ["minimum"], observations: 0, updatedAt: "2026-10-14T00:00:00Z", grantsMastery: false },
  ],
  probes: [{ probeRunId: "p-1", probeId: "minimum-probe", requestedBy: "trigger", state: "scheduled", scheduledAt: "2026-10-14T00:00:00Z", countsAsEvidence: false }],
  signals: [{ signalKind: "answer.incorrect", ruleIds: ["T3"], recommendations: [{ action: "change_representation", objectiveIds: ["minimum"] }], restraints: ["learner_pinned_hypothesis_unchanged"], createdAt: "2026-10-14T00:00:00Z" }],
};

describe("teaching hypotheses for staff", () => {
  it("shows that the learner corrected or wrote an idea without their words, plus pin, probes and trigger decisions read-only", async () => {
    const client = { teachingHypotheses: { load: vi.fn(async () => view) } } as unknown as AdminClient;
    render(<TeachingHypothesesCard client={client} enrollment={enrollment} />);
    expect(await screen.findByText("May choose the largest value.")).toBeVisible();
    expect(screen.getByText("The learner corrected this idea. Their wording stays private to them.")).toBeVisible();
    expect(screen.getByText("Written by the learner. Their own words stay private to them.")).toBeVisible();
    expect(screen.getByText("pinned by learner")).toBeVisible();
    expect(screen.getByRole("table", { name: "Diagnostic probe runs (never evidence)" })).toHaveTextContent("minimum-probetriggerscheduled");
    await userEvent.click(screen.getByText("Recent trigger table decisions"));
    expect(screen.getByText(/rules T3 · recommended change_representation · restraints learner_pinned_hypothesis_unchanged/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /reject|pin|correct/i })).toBeNull();
  });
  it("is absent for erased enrollments and when the port is not configured", () => {
    const load = vi.fn();
    const { container } = render(<TeachingHypothesesCard client={{ teachingHypotheses: { load } } as unknown as AdminClient} enrollment={{ ...enrollment, status: "erased" }} />);
    expect(container).toBeEmptyDOMElement();
    expect(load).not.toHaveBeenCalled();
    const { container: none } = render(<TeachingHypothesesCard client={{} as AdminClient} enrollment={enrollment} />);
    expect(none).toBeEmptyDOMElement();
  });
  it("reads the admin endpoint and refuses a response that presents a hypothesis as evidence", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/enrollments/${enrollment.id}/hypotheses`);
      return new Response(JSON.stringify({ ...view, items: [{ ...view.items[0], grantsMastery: true }] }), { status: 200 });
    });
    const client = createFetchAdminClient({ baseUrl: "/api/admin", fetch: fetcher as unknown as typeof fetch });
    await expect(client.teachingHypotheses!.load(enrollment.id)).rejects.toThrow();
  });
  it("refuses a response that carries the learner's corrected wording", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...view, items: [{ ...view.items[0], learnerCorrection: "Private wording." }] }), { status: 200 }));
    const client = createFetchAdminClient({ baseUrl: "/api/admin", fetch: fetcher as unknown as typeof fetch });
    await expect(client.teachingHypotheses!.load(enrollment.id)).rejects.toThrow();
  });
});

describe("hypothesis changes in the run inspector", () => {
  it("lists what the run changed, by identifier and state only", async () => {
    const summary = { id: "run-1", label: "Supervisor", status: "applied" as const, startedAt: "2026-10-14T00:00:00.000Z", contextVersion: "v1", toolCalls: 2, providerAttempts: 3, artifactCount: 1 };
    const run: SupervisorRun = { ...summary, summary: "Persisted applied job.", events: [], context: [], decisions: [], artifacts: [],
      hypothesisChanges: [{ hypothesisId: "h-1", action: "proposed", revision: 1, kind: "misconception", status: "probing", pinnedByLearner: false, templateId: "mix-up", time: "2026-10-14T00:00:01.000Z" },
        { hypothesisId: "h-1", action: "probe_scheduled", revision: 2, kind: "misconception", status: "probing", pinnedByLearner: false, templateId: "mix-up", time: "2026-10-14T00:00:02.000Z" }] };
    const client = { getRun: vi.fn(async () => run) } as unknown as AdminClient;
    render(<RunsView data={{ course: { id: "c" }, runs: [summary], permissions: ["run.inspect"] } as unknown as CourseWorkspace} client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Tool decisions" }));
    const table = screen.getByRole("table", { name: /Teaching hypothesis changes by this run/ });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table).toHaveTextContent("mix-upproposed · r1misconception · probing");
    expect(table).toHaveTextContent("probe scheduled · r2");
  });
});
