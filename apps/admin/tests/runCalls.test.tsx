import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RunsView } from "../src/views/RunsView";
import type { AdminClient, CourseWorkspace, SupervisorRun } from "../src/domain/contracts";

const summary = { id: "run-1", label: "Reviewer draft", status: "applied" as const, startedAt: "2026-10-14T00:00:00.000Z", contextVersion: "v1", toolCalls: 0, providerAttempts: 2, artifactCount: 1 };
const run: SupervisorRun = { ...summary, summary: "Persisted applied job.", events: [], context: [], decisions: [], artifacts: [],
  providerCalls: [{ operationId: "op/generate", state: "completed", failureCode: null, providerId: "test", modelId: "reviewer-model", operation: "assess",
    inputCharacters: 420, requestedMaxOutputTokens: 1000, startedAt: "2026-10-14T00:00:01.000Z", durationMs: 812,
    attempts: [{ attempt: 1, status: 503, outcome: "retryable_error", tokens: { input: null, output: null, total: null } }, { attempt: 2, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30 } }] }],
  verification: { verifier: "Written-answer reviewer drafts v1", verdict: "verified", applicationKind: "rubric_suggestion", verifiedAt: "2026-10-14T00:00:02.000Z", applied: { kind: "rubric_suggestion", at: "2026-10-14T00:00:03.000Z" } } };

describe("provider calls in the run inspector", () => {
  it("shows each call's model, attempts, token counts, duration and host verification without any content", async () => {
    const client = { getRun: vi.fn(async () => run) } as unknown as AdminClient;
    render(<RunsView data={{ course: { id: "c" }, runs: [summary], permissions: ["run.inspect"] } as unknown as CourseWorkspace} client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "Provider calls" }));
    expect(screen.getByRole("heading", { name: "reviewer-model" })).toBeVisible();
    expect(screen.getByText("812 ms")).toBeVisible();
    expect(screen.getByRole("table", { name: "Attempts reported by the provider" })).toHaveTextContent("503retryable_error? / ? / ?");
    expect(screen.getByRole("table", { name: "Attempts reported by the provider" })).toHaveTextContent("200response10 / 20 / 30");
    expect(screen.getByText(/Host verification by/)).toHaveTextContent("verified · applied as rubric_suggestion");
  });
});
