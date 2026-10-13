import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { parseResources, createResourcesClient } from "../src/client/resourcesClient";
import { EpisodeResources } from "../src/components/EpisodeResources.web";

const video = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Maximum walkthrough",
  url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  excerpts: [],
  whyUseful: "Shows the running-maximum invariant with a worked trace.",
  reviewedAt: "2026-10-13T10:00:00Z",
  expiresAt: "2026-11-13T10:00:00Z",
  rightsUse: "embed",
  attributions: [{ providerName: "YouTube", authorName: "Public educator" }],
  youtube: {
    videoId: "aqz-KE-bpKQ",
    embed: { src: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?playsinline=1&rel=0", title: "Maximum walkthrough" },
    fallback: { text: "Keep the larger value after each comparison, then check every element." },
  },
};
const page = {
  ...video,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Finding a minimum",
  url: "https://docs.python.org/3/library/functions.html",
  rightsUse: "excerpt",
  excerpts: ["Each comparison keeps the smaller value"],
  youtube: undefined,
};
const body = (resources: unknown[], extra = {}) => ({ episodeId: "min", resources, optional: true, grantsCredit: false, ...extra });

describe("optional reviewed episode resources", () => {
  it("rejects credit-bearing envelopes and drops unsafe items instead of rendering them", () => {
    expect(() => parseResources(body([page], { grantsCredit: true }))).toThrow();
    expect(() => parseResources(body([page], { optional: false }))).toThrow();
    const parsed = parseResources(
      body([
        page,
        video,
        { ...page, id: "x1", url: "http://docs.python.org/plain" },
        { ...page, id: "x2", url: "javascript:alert(1)" },
        { ...page, id: "x3", rightsUse: "download" },
        { ...video, id: "x4", youtube: { ...video.youtube, embed: { src: "https://www.youtube.com/embed/aqz-KE-bpKQ", title: "t" } } },
      ]),
    );
    expect(parsed.map((r) => r.id)).toEqual([page.id, video.id, "x4"]);
    // An embed with an unexpected host loses its player but keeps the link.
    expect(parsed[2]!.youtube).toBeUndefined();
    expect(parsed[1]!.youtube?.embedSrc).toBe(video.youtube.embed.src);
  });

  it("renders as collapsed optional help, loads a player only on request and never claims credit", async () => {
    const calls: string[] = [];
    const client = createResourcesClient({
      request: (async (url: string) => {
        calls.push(url);
        return body([page, video]);
      }) as never,
    });
    const { container } = render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    await screen.findByText("2 reviewed resources for this episode");
    expect(calls).toEqual(["/api/enrollments/e-1/resources?episodeId=min"]);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByText("2 reviewed resources for this episode"));
    expect(screen.getByText(/does not count toward progress/)).toBeInTheDocument();
    expect(screen.getByText("Each comparison keeps the smaller value")).toBeInTheDocument();
    expect(screen.getByText(video.youtube.fallback.text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Load video player/ }));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe(video.youtube.embed.src);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation");
    expect(screen.getAllByRole("link", { name: /Open source/ })[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("stays out of the way when nothing is attached and reports failure without blocking", async () => {
    const empty = createResourcesClient({ request: (async () => body([])) as never });
    const { container } = render(<EpisodeResources client={empty} enrollmentId="e" episodeId="min" />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    const failing = createResourcesClient({ request: (async () => { throw new Error("offline"); }) as never });
    render(<EpisodeResources client={failing} enrollmentId="e" episodeId="min" />);
    await screen.findByText("Reviewed resources are unavailable right now");
  });
});
