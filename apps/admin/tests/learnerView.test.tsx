import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { createAdminTranslator } from "../src/i18n";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { LearnerDataCard } from "../src/components/LearnerDataCard";
import {
  LearnerDataError,
  learnerDataErrorMessage,
} from "../src/domain/learnerData";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { LearnerViewCard } from "../src/components/LearnerViewCard";
import { Markdown } from "../src/components/LearnerViewScreen";
import {
  learnerViewErrorMessage,
  LearnerViewError,
} from "../src/domain/learnerView";
import type { AdminClient, Enrollment } from "../src/domain/contracts";
import { enrollmentId, sample } from "./learnerViewFixture";

const enrollment = { id: enrollmentId, status: "active" } as Enrollment;

describe("read-only learner view", () => {
  it("is a single GET on the admin API and maps server refusals", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sample()))
      .mockResolvedValueOnce(
        Response.json({ error: "FORBIDDEN" }, { status: 403 }),
      );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    expect(
      (await client.learnerView!.open(enrollmentId)).learner.displayName,
    ).toBe("Sam");
    expect(fetcher.mock.calls[0]![0]).toBe(
      `/api/admin/enrollments/${enrollmentId}/learner-view`,
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      body: undefined,
    });
    const refused = await client
      .learnerView!.open(enrollmentId)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LearnerViewError);
    expect(learnerViewErrorMessage(refused)).toMatch(
      /Only workspace owners and admins/,
    );
  });

  it("opens only on request and renders the learner's lesson, gate and open check without any command", async () => {
    const open = vi.fn(async () => sample());
    render(
      <LearnerViewCard
        client={{ learnerView: { open } } as unknown as AdminClient}
        enrollment={enrollment}
      />,
    );
    expect(open).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Sam · Public course/,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(
      await within(dialog).findByText("Read-only view of Sam's learning space"),
    ).toBeVisible();
    expect(within(dialog).getByText("1 of 1 parts read")).toBeVisible();
    expect(within(dialog).getByText("Which is smaller?")).toBeVisible();
    // The learner's profile goal is shown to staff who may open the view.
    expect(within(dialog).getByText("Learning goal")).toBeVisible();
    expect(
      within(dialog).getByText("Compare values with confidence."),
    ).toBeVisible();
    for (const radio of within(dialog).getAllByRole("radio"))
      expect(radio).toBeDisabled();
    expect(dialog.querySelector("form, textarea, script")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Second lesson/ }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "Second lesson" }),
    ).toBeVisible();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shows the learner's checkpoint decision, next steps and gate review read-only", async () => {
    const view = sample();
    view.snapshot.lessons[0]!.gate = {
      ...view.snapshot.lessons[0]!.gate!,
      status: "closed_with_gaps",
      learnerVisibleReason:
        "The course limit was reached before this checkpoint was ready.",
      criterionResults: [
        {
          criterionId: "transfer",
          met: false,
          reason: "Needs a new transfer task.",
        },
      ],
      nextActions: [
        {
          kind: "appeal",
          label: "Request a staff review of this decision within 14 days",
        },
      ],
      review: {
        state: "upheld",
        reviewerNote: "Extend first.",
        requestedAt: "2026-10-15T10:00:00.000Z",
      },
      exception: null,
    };
    const open = vi.fn(async () => view);
    render(
      <LearnerViewCard
        client={{ learnerView: { open } } as unknown as AdminClient}
        enrollment={enrollment}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Sam · Public course/,
    });
    expect(
      await within(dialog).findByText("Checkpoint decision: closed with gaps"),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        "The course limit was reached before this checkpoint was ready.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/Still needed · Needs a new transfer task\./),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("list", { name: "Learner next steps" }),
    ).toHaveTextContent(
      "Request a staff review of this decision within 14 days",
    );
    expect(
      within(dialog).queryByRole("button", { name: /Request a staff review/ }),
    ).toBeNull();
    expect(within(dialog).getByText(/upheld · “Extend first\.”/)).toBeVisible();
    expect(dialog.querySelector("form, textarea")).toBeNull();
  });

  it("shows the course-made media attached for the learner read-only, with captions and transcript, under the view's links", async () => {
    const view = sample();
    const viewId = view.view.id,
      mediaId = "2b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f63";
    const base = `/api/admin/enrollments/${enrollmentId}/learner-view/${viewId}/media/${mediaId}`;
    view.generatedMedia = [
      {
        id: mediaId,
        episodeId: "one",
        title: "Running minimum in motion",
        objective: "Show the running minimum after each comparison.",
        transcript: "The running minimum keeps the smaller value.",
        visualDescription: "A highlight moves along five boxes.",
        captions: true,
        mimeType: "video/mp4",
        byteLength: 64,
        reviewedAt: "2026-10-14T09:00:00.000Z",
        expiresAt: "2026-10-20T09:00:00.000Z",
        state: "available",
        assetUrl: `${base}/asset`,
        captionsUrl: `${base}/captions.vtt`,
      },
    ];
    const canPlay = vi
      .spyOn(HTMLMediaElement.prototype, "canPlayType")
      .mockReturnValue("maybe");
    try {
      const open = vi.fn(async () => view);
      render(
        <LearnerViewCard
          client={{ learnerView: { open } } as unknown as AdminClient}
          enrollment={enrollment}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Open read-only learner view" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: /Sam · Public course/,
      });
      const help = (
        await within(dialog).findByRole("heading", { name: "Optional help" })
      ).closest("section")!;
      expect(
        within(help).getByRole("heading", {
          name: "Running minimum in motion",
        }),
      ).toBeVisible();
      expect(within(help).getByText("shown to learner")).toBeVisible();
      expect(within(help).getByText("English captions")).toBeVisible();
      expect(
        within(help).getByText("The running minimum keeps the smaller value."),
      ).toBeVisible();
      const video = help.querySelector("video")!;
      expect(video.getAttribute("preload")).toBe("none");
      expect(video.hasAttribute("autoplay")).toBe(false);
      expect(help.querySelector("source")!.getAttribute("src")).toBe(
        `${base}/asset`,
      );
      expect(help.querySelector("track")!.getAttribute("src")).toBe(
        `${base}/captions.vtt`,
      );
      expect(help.querySelector("form, textarea, button")).toBeNull();
      // A clip that fails to load falls back to a placeholder; the text stays.
      help.querySelector("source")!.dispatchEvent(new Event("error"));
      expect(
        await within(help).findByText("Video not playable here."),
      ).toBeVisible();
      expect(help.querySelector("video")).toBeNull();
      expect(
        within(help).getByText("A highlight moves along five boxes."),
      ).toBeVisible();
      // Media of another lesson is shown only with that lesson.
      await userEvent.click(
        within(dialog).getByRole("button", { name: /Second lesson/ }),
      );
      expect(
        within(dialog).queryByRole("heading", { name: "Optional help" }),
      ).toBeNull();
    } finally {
      canPlay.mockRestore();
    }
  });

  it("shows a placeholder when the browser cannot play the clip's format, and refuses foreign media links", async () => {
    const view = sample();
    const mediaId = "2b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f63";
    const clip = {
      id: mediaId,
      episodeId: "one",
      title: "Clip",
      objective: "Show the minimum.",
      transcript: "Transcript text here.",
      visualDescription: null,
      captions: false,
      mimeType: "video/webm" as const,
      byteLength: 10,
      reviewedAt: "2026-10-14T09:00:00.000Z",
      expiresAt: "2026-10-20T09:00:00.000Z",
      state: "available" as const,
      assetUrl: `/api/admin/enrollments/${enrollmentId}/learner-view/${view.view.id}/media/${mediaId}/asset`,
      captionsUrl: null,
    };
    view.generatedMedia = [clip];
    const canPlay = vi
      .spyOn(HTMLMediaElement.prototype, "canPlayType")
      .mockReturnValue("");
    try {
      render(
        <LearnerViewCard
          client={
            {
              learnerView: { open: vi.fn(async () => view) },
            } as unknown as AdminClient
          }
          enrollment={enrollment}
        />,
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Open read-only learner view" }),
      );
      const dialog = await screen.findByRole("dialog", {
        name: /Sam · Public course/,
      });
      expect(
        await within(dialog).findByText("Video not playable here."),
      ).toBeVisible();
      expect(dialog.querySelector("video")).toBeNull();
      expect(within(dialog).getByText("None")).toBeVisible();
    } finally {
      canPlay.mockRestore();
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...view,
        generatedMedia: [
          { ...clip, assetUrl: "https://elsewhere.example/clip.mp4" },
        ],
      }),
    );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    await expect(client.learnerView!.open(enrollmentId)).rejects.toBeTruthy();
  });

  it("names the learner's appeal without its reason", async () => {
    const view = sample();
    view.reviews = [
      {
        attemptId: "3b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f64",
        episodeId: "one",
        assessmentId: "explain",
        submittedAt: "2026-10-14T09:00:00.000Z",
        status: "met",
        reviewedAt: "2026-10-14T09:30:00.000Z",
        learnerNote: null,
        continuesAttemptId: null,
        canReply: false,
        canAppeal: false,
        appeal: { state: "open", note: null, reason: null },
        criteria: [],
      },
    ];
    render(
      <LearnerViewCard
        client={
          {
            learnerView: { open: vi.fn(async () => view) },
          } as unknown as AdminClient
        }
        enrollment={enrollment}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Sam · Public course/,
    });
    expect(
      await within(dialog).findByText(/second opinion open/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/reason for a second opinion is not shown here/),
    ).toBeVisible();
  });

  it("is disabled for an erased enrollment and absent without the port", () => {
    const { container, unmount } = render(
      <LearnerViewCard client={{} as AdminClient} enrollment={enrollment} />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(
      <LearnerViewCard
        client={{ learnerView: { open: vi.fn() } } as unknown as AdminClient}
        enrollment={{ ...enrollment, status: "erased" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    ).toBeDisabled();
  });

  it("renders prose as text, never as HTML", () => {
    const { container } = render(
      <Markdown
        markdown={
          "# Title\n\nUse `min` and **care** <img src=x onerror=alert(1)>\n\n```py\nprint(1)\n```"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { name: "Title" })).toBeVisible();
    expect(screen.getByText("min").tagName).toBe("CODE");
    expect(screen.getByText("print(1)")).toBeVisible();
  });

  it("renders in Hebrew, right to left, with course text isolated and codes left to right", async () => {
    window.history.replaceState(null, "", "/admin/?locale=he");
    const open = vi.fn(async () => sample());
    try {
      render(
        <LocaleProvider>
          <LearnerViewCard
            client={{ learnerView: { open } } as unknown as AdminClient}
            enrollment={enrollment}
          />
        </LocaleProvider>,
      );
      expect(document.documentElement).toHaveAttribute("dir", "rtl");
      await userEvent.click(
        screen.getByRole("button", {
          name: "פתיחת תצוגת הלומד/ת לקריאה בלבד",
        }),
      );
      const dialog = await screen.findByRole("dialog");
      const text = stripBidiControls(dialog.textContent ?? "");
      expect(text).toContain("תצוגה לקריאה בלבד של מרחב הלמידה של Sam");
      expect(text).toContain("1 מתוך 1 חלקים נקראו");
      expect(text).toContain("מטרת הלמידה");
      expect(text).not.toMatch(/parts read|Learning goal|Gate evidence/);
      // Course text keeps its own direction; the learner's goal too.
      expect(
        within(dialog).getByRole("heading", { name: "First lesson" }),
      ).toHaveAttribute("dir", "auto");
      expect(
        within(dialog).getByText("Compare values with confidence."),
      ).toHaveAttribute("dir", "auto");
    } finally {
      window.history.replaceState(null, "", "/");
      document.documentElement.lang = "";
      document.documentElement.dir = "";
    }
  });

  it("translates learner view and learner data refusals, defaulting to the unavailable message", () => {
    const he = createAdminTranslator("he").t;
    expect(learnerViewErrorMessage(new LearnerViewError("FORBIDDEN"), he)).toBe(
      "רק בעלים ומנהלים של סביבת העבודה יכולים לצפות במרחב של לומד/ת.",
    );
    expect(learnerViewErrorMessage(new LearnerViewError("SOMETHING_NEW"))).toBe(
      "The learner view is unavailable right now. Nothing was changed.",
    );
    expect(
      learnerDataErrorMessage(new LearnerDataError("ALREADY_ERASED"), he),
    ).toBe("נתוני הלמידה של ההרשמה הזו כבר נמחקו.");
    expect(learnerDataErrorMessage(new Error("boom"), he)).toBe(
      "שירות הנתונים לא זמין. שום דבר לא יוצא ולא נמחק.",
    );
  });

  it("asks for the erasure phrase left to right in the Hebrew data card", () => {
    window.history.replaceState(null, "", "/admin/?locale=he");
    try {
      render(
        <LocaleProvider>
          <LearnerDataCard
            client={
              {
                learnerData: { exportEnrollment: vi.fn(), erase: vi.fn() },
              } as unknown as AdminClient
            }
            enrollment={enrollment}
            onErased={() => {}}
          />
        </LocaleProvider>,
      );
      expect(
        screen.getByRole("button", { name: "ייצוא נתוני הלומד/ת" }),
      ).toBeVisible();
      const phrase = `ERASE ${enrollmentId.slice(0, 8)}`;
      const input = screen.getByLabelText(
        (label) => stripBidiControls(label) === `כדי לאשר, יש להקליד ${phrase}`,
      );
      expect(input).toHaveAttribute("dir", "ltr");
    } finally {
      window.history.replaceState(null, "", "/");
      document.documentElement.lang = "";
      document.documentElement.dir = "";
    }
  });
});
