import { describe, expect, it } from "vitest";
import { createDemoMedia } from "../src/client/demoMedia";
import {
  MediaActionError,
  mediaCheckSchema,
  mediaEstimateSchema,
  mediaJobSchema,
  mediaLibrarySchema,
  storyboardSchema,
  type MediaReviewInput,
} from "../src/domain/media";

const RELEASE = "sorting-release";
const media = (options: Parameters<typeof createDemoMedia>[0] = {}) =>
  createDemoMedia({
    latency: 0,
    now: () => new Date("2026-10-20T10:00:00.000Z"),
    ...options,
  });
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof MediaActionError ? error.code : String(error),
  );
const approval = (sha: string): MediaReviewInput => ({
  decision: "approved",
  assetSha256: sha,
  visualDescription: "Five cards in a row, the smallest one last.",
  findings: {
    factualAccuracy: true,
    labelsAndEquations: true,
    captionsMatchNarration: true,
    noMisleadingMotion: true,
  },
  rationale: "Matches the lesson's starting order exactly.",
});

describe("demo generated media", () => {
  it("lists a release's jobs and storyboards in the server's shapes, with no live generation", async () => {
    const port = media();
    const library = mediaLibrarySchema.parse(await port.library(RELEASE));
    expect(library.liveGenerationVerified).toBe(false);
    expect(library.jobs.map((j) => j.state).sort()).toEqual(
      ["attached", "failed", "uncertain", "under_review"].sort(),
    );
    for (const job of library.jobs) {
      expect(job.grantsCredit).toBe(false);
      expect(job.learnerVisible).toBe(job.state === "attached");
      mediaJobSchema.parse(await port.detail(job.id));
    }
    const boards = await port.storyboards(RELEASE);
    expect(boards).toHaveLength(1);
    boards.forEach((b) => storyboardSchema.parse(b));
    const learner = library.enrollments[0]!.id;
    mediaEstimateSchema.parse(await port.estimate(learner, "ep-1"));
    expect(await code(port.library("sorting-draft"))).toBe(
      "MEDIA_EPISODE_OUT_OF_SCOPE",
    );
  });

  it("takes an image through check, review and attachment before a learner sees it", async () => {
    const port = media();
    const library = await port.library(RELEASE);
    const waiting = library.jobs.find((j) => j.state === "under_review")!;
    expect(port.assetUrl(waiting.id)).toMatch(/^data:image\/svg\+xml/);
    const check = mediaCheckSchema.parse(
      await port.check(
        waiting.id,
        { visualDescription: "Five cards in a row.", useModel: true },
        "k-check",
      ),
    );
    expect(check.rules.verdict).toBe("consistent");
    expect(check.model?.verdict).toBe("unverified");
    // An incomplete checklist and a changed asset are refused.
    expect(
      await code(
        port.review(
          waiting.id,
          {
            ...approval(waiting.asset!.sha256),
            findings: { ...approval("").findings, factualAccuracy: false },
          },
          "k-incomplete",
        ),
      ),
    ).toBe("MEDIA_REVIEW_FINDINGS_INCOMPLETE");
    expect(
      await code(port.review(waiting.id, approval("0".repeat(64)), "k-sha")),
    ).toBe("MEDIA_ASSET_CHANGED");
    await port.review(waiting.id, approval(waiting.asset!.sha256), "k-review");
    // The same key replays; the same key for another action is a conflict.
    await port.review(waiting.id, approval(waiting.asset!.sha256), "k-review");
    expect(await code(port.cancel(waiting.id, "k-review"))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    let job = mediaJobSchema.parse(await port.detail(waiting.id));
    expect(job.state).toBe("approved");
    expect(job.learnerVisible).toBe(false);
    expect(
      await code(port.attach(waiting.id, "2020-01-01T00:00:00Z", "k-past")),
    ).toBe("MEDIA_EXPIRY_INVALID");
    await port.attach(waiting.id, "2026-11-20T00:00:00.000Z", "k-attach");
    job = mediaJobSchema.parse(await port.detail(waiting.id));
    expect(job.state).toBe("attached");
    expect(job.learnerVisible).toBe(true);
    await port.revoke(job.attachment!.id, "Wrong episode.", "k-revoke");
    expect(
      await code(port.revoke(job.attachment!.id, "Again.", "k-revoke-2")),
    ).toBe("MEDIA_ATTACHMENT_ALREADY_REVOKED");
    job = mediaJobSchema.parse(await port.detail(waiting.id));
    expect(job.learnerVisible).toBe(false);
    expect(job.events!.length).toBeGreaterThan(5);
  });

  it("queues a video request without calling a provider and lets staff cancel it", async () => {
    const port = media();
    const library = await port.library(RELEASE);
    const learner = library.enrollments[0]!.id;
    const job = mediaJobSchema.parse(
      await port.request(
        learner,
        {
          episodeId: "ep-1",
          title: "Comparing neighbours",
          objective: "See one comparison.",
          script: "Two cards side by side; the larger moves right.",
        },
        "k-request",
      ),
    );
    expect(job.state).toBe("polling");
    expect(job.asset).toBeNull();
    expect(
      await code(
        port.request(
          learner,
          { episodeId: "ep-9", title: "x", objective: "y", script: "z" },
          "k-scope",
        ),
      ),
    ).toBe("MEDIA_EPISODE_OUT_OF_SCOPE");
    await port.cancel(job.id, "k-cancel");
    const cancelled = await port.detail(job.id);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.remoteMayContinue).toBe(true);
  });

  it("reviews storyboards and refuses what the demo cannot do", async () => {
    const port = media();
    const [board] = await port.storyboards(RELEASE);
    expect(
      await code(port.reviewStoryboard(board!.id, 99, "approved", "k-stale")),
    ).toBe("MEDIA_STORYBOARD_REVISION_CONFLICT");
    const approved = storyboardSchema.parse(
      await port.reviewStoryboard(
        board!.id,
        board!.revision,
        "approved",
        "k-approve",
      ),
    );
    expect(approved.state).toBe("approved");
    expect(await code(port.compose(board!.id, "k-compose"))).toBe(
      "MEDIA_CLIP_TOOLCHAIN_MISSING",
    );
    expect(
      await code(
        port.createStoryboard(
          board!.enrollmentId,
          {
            episodeId: "ep-1",
            title: "t",
            objective: "o",
            script: "s",
            draftWith: "model",
          },
          "k-model",
        ),
      ),
    ).toBe("MEDIA_ASSISTANT_UNAVAILABLE");
  });

  it("follows the demo role and scenario", async () => {
    const observer = media({ role: "observer" });
    const library = await observer.library(RELEASE);
    expect(library.permissions).toEqual({
      request: false,
      review: false,
      attach: false,
    });
    expect(await code(observer.cancel(library.jobs[0]!.id, "k-observer"))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(media({ scenario: "permission_denied" }).library(RELEASE)),
    ).toBe("FORBIDDEN");
    expect(
      await code(media({ scenario: "load_failure" }).library(RELEASE)),
    ).toBe("Error: unavailable");
  });
});
