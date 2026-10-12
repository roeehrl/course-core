import { afterEach, describe, expect, it, vi } from "vitest";
import {
  demo,
  context,
  request,
  enrollmentId,
  proposal,
  enrollmentContext,
} from "./helpers";
afterEach(() => vi.useRealTimers());

describe("release and enrollment authority", () => {
  it("requires review and approval before publication and preserves pinned enrollments", async () => {
    const client = demo();
    await expect(
      client.transitionRelease(
        "sorting",
        "sorting-draft",
        "publish",
        context(),
      ),
    ).rejects.toMatchObject({ code: "pending_review" });
    const review = await client.transitionRelease(
      "sorting",
      "sorting-draft",
      "submit-review",
      context(),
    );
    expect(review.workspace.releases[0]?.state).toBe("pending_review");
    await expect(
      client.transitionRelease(
        "sorting",
        "sorting-draft",
        "publish",
        context("2"),
      ),
    ).rejects.toMatchObject({ code: "pending_review" });
    await client.transitionRelease(
      "sorting",
      "sorting-draft",
      "approve",
      context("2"),
    );
    const published = await client.transitionRelease(
      "sorting",
      "sorting-draft",
      "publish",
      context("3"),
    );
    expect(published.workspace.releases[0]?.state).toBe("published");
    expect(published.workspace.enrollments[0]?.releaseVersion).toBe("1.0.0");
    expect(published.receipt.authority).toBe("demo");
  });
  it("does not invent successful validation for a newly authored draft", async () => {
    const client = demo();
    const result = await client.createRelease(
      "sorting",
      { version: "2.0.0", notes: "Public sample change." },
      context(),
    );
    await expect(
      client.transitionRelease(
        "sorting",
        result.workspace.releases[0]!.id,
        "submit-review",
        context("2"),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });
  it("enforces observer permissions even when called directly", async () => {
    const client = demo({ role: "observer" });
    await expect(
      client.updateCourse(
        "sorting",
        { title: "Changed", description: "" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      client.proposeExtension(enrollmentId, proposal, enrollmentContext()),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      client.getRun("sorting", "sorting-run-01"),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("rejects stale updates and permits a reviewed retry after refreshing", async () => {
    const client = demo({ scenario: "stale_revision" });
    await expect(
      client.updateCourse(
        "sorting",
        { title: "Updated title", description: "" },
        context(),
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const latest = await client.getCourse("sorting");
    expect(latest.revision).toBe("2");
    const saved = await client.updateCourse(
      "sorting",
      { title: "Updated title", description: "" },
      context(latest.revision),
    );
    expect(saved.workspace.course.title).toBe("Updated title");
    expect((await client.getCourse("graphs")).course.title).toBe(
      "A first look at graphs",
    );
  });
  it("keeps profiles separate from evidence and rejects obsolete evidence reviews", async () => {
    const client = demo();
    const profile = {
      displayName: "Changed Example",
      goal: "Understand.",
      pace: "gentle" as const,
    };
    const saved = await client.updateProfile(
      "sorting",
      "sorting-learner-01",
      profile,
      context(),
    );
    expect(saved.workspace.enrollments[0]?.completed).toBe(1);
    await expect(
      client.reviewEvidence(
        "sorting",
        "sorting-learner-01",
        "ev-03",
        { decision: "accept", note: "Reviewed" },
        context("2"),
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const accepted = await client.reviewEvidence(
      "sorting",
      "sorting-learner-01",
      "ev-02",
      { decision: "accept", note: "Meets the example rubric." },
      context("2"),
    );
    expect(accepted.workspace.enrollments[0]?.completed).toBe(1);
    expect(accepted.workspace.enrollments[0]?.evidence[1]?.receiptId).toMatch(
      /^demo-/,
    );
  });
  it("creates an enrollment without fabricated consent, balance or progress", async () => {
    const client = demo();
    const input = {
      learnerRef: "new-example",
      profile: {
        displayName: "New Example",
        goal: "",
        pace: "steady" as const,
      },
    };
    const result = await client.enroll("sorting", input, context());
    expect(result.workspace.enrollments.at(-1)).toMatchObject({
      completed: 0,
    });
    await expect(
      client.enroll("sorting", input, context("2")),
    ).rejects.toMatchObject({ code: "validation" });
  });
});
