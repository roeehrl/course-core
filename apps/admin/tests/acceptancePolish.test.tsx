import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  questionLine,
  sharedLeads,
  siteNames,
} from "../src/views/contentShared";
import {
  modelName,
  readableModelId,
  rememberModelNames,
} from "../src/components/aiServices/modelNames";
import { When } from "../src/components/ui";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

describe("question rows (Answer keys)", () => {
  const prompts = [
    "Independent check. Sort [3, 1, 2] by hand.",
    "Independent check. Which pass moves 1 first?",
    "Independent check.\nTrace the second pass.",
    "Independent transfer check. Apply it to names.",
    "Why does the inner loop stop early?",
  ];
  it("skips a lead-in many questions share and keeps the question on one line", () => {
    const leads = sharedLeads(prompts);
    expect([...leads]).toEqual(["Independent check."]);
    expect(questionLine(prompts[0]!, leads)).toBe("Sort [3, 1, 2] by hand.");
    expect(questionLine(prompts[2]!, leads)).toBe("Trace the second pass.");
    // A lead-in only one question has is part of that question.
    expect(questionLine(prompts[3]!, leads)).toBe(
      "Independent transfer check. Apply it to names.",
    );
    expect(questionLine(prompts[4]!, leads)).toBe(prompts[4]);
  });
});

describe("site names (Research sources)", () => {
  it("names YouTube once for its three hosts and drops www. elsewhere", () => {
    expect(
      siteNames([
        "www.youtube.com",
        "youtube.com",
        "youtu.be",
        "www.example.org",
      ]),
    ).toEqual(["YouTube", "example.org"]);
  });
});

describe("model names (AI services)", () => {
  it("reads a model id as a name until the service's own name is known", () => {
    expect(readableModelId("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(readableModelId("models/gpt-5.1-mini")).toBe("GPT 5.1 Mini");
    rememberModelNames({
      models: [
        {
          remoteModel: "acme-x1",
          displayName: "Acme X1 (preview)",
          description: "",
          inputTokenLimit: null,
          outputTokenLimit: null,
          methods: [],
        },
      ],
    });
    expect(modelName("acme-x1")).toBe("Acme X1 (preview)");
  });
});

describe("times", () => {
  it("shows a time in the viewer's zone with the UTC time as its tooltip", () => {
    render(
      <I18nProvider value={createAdminTranslator("en")}>
        <When iso="2026-11-02T09:33:00Z" />
      </I18nProvider>,
    );
    const time = screen.getByText(/Nov 2, 2026/);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-11-02T09:33:00Z");
    expect(time).toHaveAttribute("title", "Nov 2, 2026, 9:33 AM UTC");
    // The text is the browser zone's (UTC under test), formatted without a fixed zone.
    expect(time.textContent).toBe(
      new Intl.DateTimeFormat("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date("2026-11-02T09:33:00Z")),
    );
  });
});

describe("generated media without a media model", () => {
  it("does not warn about unverified live generation, and links to AI services → Models", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { MediaView } = await import("../src/views/MediaView");
    const { createDemoMedia } = await import("../src/client/demoMedia");
    const { demoSession, demoWorkspace } = await import("../src/data/fixtures");
    const { takeAiServicesTarget } =
      await import("../src/components/aiServices/target");
    const demo = createDemoMedia({ latency: 0 });
    const media = {
      ...demo,
      library: async (...args: Parameters<typeof demo.library>) => ({
        ...(await demo.library(...args)),
        provider: null,
        imageProvider: null,
      }),
    };
    const session = demoSession("administrator");
    const data = demoWorkspace(session.courses[0]!, "administrator");
    let opened = 0;
    render(
      <I18nProvider value={createAdminTranslator("en")}>
        <MediaView
          data={data}
          client={{ media } as never}
          onOpenAiServices={() => (opened += 1)}
        />
      </I18nProvider>,
    );
    const link = await screen.findByRole("button", {
      name: "Choose a media model in AI services",
    });
    expect(screen.queryByText("Live generation not verified")).toBeNull();
    fireEvent.click(link);
    expect(opened).toBe(1);
    expect(takeAiServicesTarget()).toBe("models");
    expect(takeAiServicesTarget()).toBeUndefined();
  });
});
