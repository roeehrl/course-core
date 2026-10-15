import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createCourseApi } from "../src/client/apiClient";
import {
  createHypothesisClient,
  parseHypothesisSnapshot,
  type HypothesisSnapshot,
} from "../src/client/hypothesisClient";
import { TeachingHypothesesPanel } from "../src/components/TeachingHypothesesPanel";
import { connectedSnapshot } from "./connectedFixtures";

const connected = connectedSnapshot();

const enrollmentId = connected.enrollmentId;
const base = `/api/enrollments/${enrollmentId}/learner-model`;
const id = "6a6ad0f6-0e0c-4c8e-9d1e-2d7d8b0a2f10";
const runId = "0b7b0f2c-3f5e-4bb0-9a8b-1e1f8c4a7d22";
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
function snapshot(): HypothesisSnapshot {
  return {
    enrollmentId,
    courseDigest: "a".repeat(64),
    revision: 3,
    items: [
      {
        hypothesisId: id,
        revision: 1,
        templateId: "mix-up",
        kind: "misconception",
        statement: "You may be choosing the largest value instead of the smallest.",
        learnerCorrection: null,
        status: "proposed",
        uncertainty: "high",
        source: "assessment",
        pinned: false,
        rejectedBy: null,
        objectiveIds: [connected.course.objectives[0]!.id],
        observations: 1,
        evidenceRefs: [{ kind: "attempt", id: "attempt-1", supports: true, at: "2026-01-01T00:00:00Z" }],
        evidenceRefsTruncated: false,
        expiresAt: "2026-02-01T00:00:00Z",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        probeAvailable: true,
        grantsMastery: false,
      },
    ],
    probes: [],
    requests: [],
    limits: { diagnosticRequestsPerDay: 3, openProbes: 2, probesPerDay: 3 },
    notEvidence: true,
  };
}
function harness(initial = snapshot()) {
  let model = structuredClone(initial);
  const posts: { path: string; body: any }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (init.method !== "POST") return response(model);
    const body = JSON.parse(String(init.body));
    posts.push({ path: url.pathname, body });
    if (body.expectedRevision !== model.revision) return response({ error: "STALE_REVISION" }, 409);
    model.revision++;
    const receipt = { revision: model.revision, eventId: "event-" + model.revision, grantsMastery: false };
    if (url.pathname.endsWith("/decision")) {
      const h = model.items[0]!;
      if (body.expectedHypothesisRevision !== h.revision) return response({ error: "HYPOTHESIS_CHANGED" }, 409);
      h.revision++;
      if (body.action === "pin") { h.pinned = true; h.expiresAt = null; }
      if (body.action === "unpin") h.pinned = false;
      if (body.action === "correct") h.learnerCorrection = body.correction;
      if (body.action === "reject") { h.status = "rejected"; h.rejectedBy = "learner"; h.pinned = false; }
      return response({ ...receipt, hypothesisId: h.hypothesisId });
    }
    if (url.pathname.endsWith("/diagnostics")) {
      if (model.items[0]) model.items[0].status = "probing";
      model.probes = [{ probeRunId: runId, probeId: "probe", hypothesisIds: [id], requestedBy: "learner", state: "scheduled",
        question: { id: "item", type: "choice", prompt: "Which is the smallest of 4, 9 and 2?", options: [{ id: "four", text: "4" }, { id: "nine", text: "9" }, { id: "two", text: "2" }] },
        outcome: null, scheduledAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-08T00:00:00Z", answeredAt: null, countsAsEvidence: false }];
      return response({ ...receipt, state: "probe_scheduled", probeRunId: runId });
    }
    if (url.pathname.endsWith("/answer")) {
      model.probes[0]!.state = body.abstain ? "abstained" : "answered";
      model.probes[0]!.question = null;
      if (!body.abstain && model.items[0]) model.items[0].status = "confirmed";
      return response({ ...receipt, probeRunId: runId, outcome: body.abstain ? "abstained" : "incorrect", correct: body.abstain ? null : false,
        explanation: body.abstain ? null : "2 is below 4 and 9.", conclusive: !body.abstain, hypotheses: [], countsAsEvidence: false });
    }
    return response({ error: "UNKNOWN_ROUTE" }, 404);
  });
  const api = createCourseApi({ fetch: fetcher, csrf: () => "csrf", accountId: "learner" });
  const client = createHypothesisClient(api, "learner");
  const onRevision = vi.fn();
  return { client, posts, onRevision, get model() { return model; }, set model(v) { model = v; },
    props: { enrollment: connected, client, onRevision } };
}

describe("teaching hypotheses panel through HTTP", () => {
  it("shows each idea in plain language with its source, certainty and evidence, and never as a grade", async () => {
    const h = harness();
    render(<TeachingHypothesesPanel {...h.props} />);
    expect(await screen.findByText("You may be choosing the largest value instead of the smallest.")).toBeVisible();
    expect(screen.getByText("Possible mix-up")).toBeVisible();
    expect(screen.getByText("An idea to check")).toBeVisible();
    expect(screen.getByText(/Noticed from a check answer · Tentative · based on 1 observation/)).toBeVisible();
    expect(screen.getByText(/None of this changes your progress/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show evidence for this idea" }));
    expect(screen.getByText(/Check answer supporting/)).toBeVisible();
  });

  it("pins, corrects and rejects with the hypothesis revision, and reports each change", async () => {
    const h = harness();
    render(<TeachingHypothesesPanel {...h.props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Pin idea" }));
    expect(await screen.findByText("Pinned by you")).toBeVisible();
    expect(h.posts[0]).toMatchObject({ path: `${base}/hypotheses/${id}/decision`, body: { action: "pin", expectedHypothesisRevision: 1, expectedRevision: 3 } });
    expect(h.onRevision).toHaveBeenCalledWith(4);

    await userEvent.click(screen.getByRole("button", { name: "Correct this idea" }));
    const field = screen.getByRole("textbox", { name: "Say it in your own words" });
    await userEvent.clear(field);
    await userEvent.type(field, "I mixed up the words.");
    await userEvent.click(screen.getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText("I mixed up the words.")).toBeVisible();
    expect(screen.getByText(/Your correction. Original wording/)).toBeVisible();
    expect(h.posts[1]!.body).toMatchObject({ action: "correct", correction: "I mixed up the words.", expectedHypothesisRevision: 2 });

    await userEvent.click(screen.getByRole("button", { name: "Reject this idea" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    expect(await screen.findByText(/it will not be suggested again/)).toBeVisible();
    expect(screen.getByText("No open ideas.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show earlier ideas" }));
    expect(screen.getByText("You rejected this")).toBeVisible();
  });

  it("refreshes instead of overwriting when a tutor changed the idea first", async () => {
    const h = harness();
    render(<TeachingHypothesesPanel {...h.props} />);
    await screen.findByRole("button", { name: "Pin idea" });
    h.model.items[0]!.revision = 5;
    h.model.items[0]!.status = "probing";
    await userEvent.click(screen.getByRole("button", { name: "Pin idea" }));
    expect(await screen.findByText(/This changed since you opened it/)).toBeVisible();
    expect(await screen.findByText("Being checked")).toBeVisible();
    expect(h.onRevision).not.toHaveBeenCalled();
  });

  it("asks for a check, answers it or says I don't know, and states that it never counts", async () => {
    const h = harness();
    render(<TeachingHypothesesPanel {...h.props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ask for a quick check of this idea" }));
    expect(await screen.findByText("Which is the smallest of 4, 9 and 2?")).toBeVisible();
    expect(screen.getByText("Quick check · does not count toward progress")).toBeVisible();
    const group = screen.getByRole("radiogroup", { name: "Quick check answer" });
    await userEvent.click(within(group).getByRole("radio", { name: "9" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit check" }));
    expect(await screen.findByText(/it does not count toward your progress/)).toBeVisible();
    expect(screen.getByText(/Not quite. 2 is below 4 and 9./)).toBeVisible();
    expect(h.posts.at(-1)).toMatchObject({ path: `${base}/probes/${runId}/answer`, body: { answer: "nine" } });
    await waitFor(() => expect(screen.getByText("Supported by your answers")).toBeVisible());
  });

  it("can request a check for an objective with an optional note", async () => {
    const h = harness({ ...snapshot(), items: [] });
    render(<TeachingHypothesesPanel {...h.props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Show ask for a quick check" }));
    await userEvent.type(screen.getByRole("textbox", { name: "What do you think is confusing you? (optional)" }), "I read the first number.");
    await userEvent.click(screen.getByRole("button", { name: "Ask for a check" }));
    expect(await screen.findByText("A quick check is ready above.")).toBeVisible();
    expect(h.posts[0]!.body).toMatchObject({ objectiveId: connected.course.objectives[0]!.id, note: "I read the first number." });
    await userEvent.click(screen.getByRole("button", { name: "I don’t know" }));
    expect(await screen.findByText(/nothing was marked wrong/)).toBeVisible();
    expect(h.posts.at(-1)!.body).toMatchObject({ abstain: true });
  });
});

describe("hypothesis client contract", () => {
  it("says when personal lesson support is off that answers suggest no ideas, and says nothing when it is on", async () => {
    const off = harness({ ...snapshot(), items: [], automaticIdeas: false });
    const { unmount } = render(<TeachingHypothesesPanel {...off.props} />);
    expect(await screen.findByText(/Personal lesson support is off, so your answers and questions do not suggest ideas on their own/)).toBeVisible();
    unmount();
    const on = harness({ ...snapshot(), automaticIdeas: true });
    render(<TeachingHypothesesPanel {...on.props} />);
    expect(await screen.findByText("You may be choosing the largest value instead of the smallest.")).toBeVisible();
    expect(screen.queryByText(/Personal lesson support is off/)).not.toBeInTheDocument();
    expect(() => parseHypothesisSnapshot({ ...snapshot(), automaticIdeas: "yes" }, enrollmentId)).toThrow();
  });

  it("refuses responses that would present a hypothesis or probe as evidence", () => {
    expect(() => parseHypothesisSnapshot({ ...snapshot(), items: [{ ...snapshot().items[0], grantsMastery: true }] }, enrollmentId)).toThrow();
    expect(() => parseHypothesisSnapshot({ ...snapshot(), notEvidence: false }, enrollmentId)).toThrow();
    expect(() => parseHypothesisSnapshot({ ...snapshot(), enrollmentId: "other" }, enrollmentId)).toThrow();
    expect(() => parseHypothesisSnapshot({ ...snapshot(), probes: [{ probeRunId: runId, state: "scheduled", question: null, countsAsEvidence: true }] }, enrollmentId)).toThrow();
    expect(parseHypothesisSnapshot(snapshot(), enrollmentId).items).toHaveLength(1);
  });
});
