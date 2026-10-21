import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { parseResources, parseGeneratedMedia, createResourcesClient } from "../src/client/resourcesClient";
import { installFakeYouTube } from "./youtubeFake";
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

  it("renders as collapsed optional help, loads the official player only on request and never claims credit", async () => {
    const youtube = installFakeYouTube();
    const calls: string[] = [];
    const client = createResourcesClient({
      request: (async (url: string) => {
        calls.push(url);
        return url.includes("/media?") ? { episodeId: "min", media: [], optional: true, grantsCredit: false } : body([page, video]);
      }) as never,
    });
    const { container } = render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    await screen.findByText("2 reviewed resources for this episode");
    expect(calls.sort()).toEqual(["/api/enrollments/e-1/media?episodeId=min", "/api/enrollments/e-1/resources?episodeId=min"]);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByText("2 reviewed resources for this episode"));
    expect(screen.getByText(/does not count toward progress/)).toBeInTheDocument();
    expect(screen.getByText("Each comparison keeps the smaller value")).toBeInTheDocument();
    expect(screen.getByText(video.youtube.fallback.text)).toBeInTheDocument();
    expect(youtube.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Load video player/ }));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(youtube.calls[0]).toMatchObject({ host: "https://www.youtube-nocookie.com", videoId: "aqz-KE-bpKQ", playerVars: { autoplay: 0 } });
    expect(container.querySelector("iframe")!.title).toBe("Maximum walkthrough");
    expect(screen.getAllByRole("link", { name: /Open source/ })[0]).toHaveAttribute("rel", "noopener noreferrer");
    youtube.remove();
  });

  it("an unavailable video keeps the written alternative and the source link (F08)", async () => {
    const youtube = installFakeYouTube(150);
    const client = createResourcesClient({
      request: (async (url: string) => (url.includes("/media?") ? { media: [], optional: true, grantsCredit: false } : body([video]))) as never,
    });
    render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    fireEvent.click(await screen.findByText("1 reviewed resource for this episode"));
    fireEvent.click(screen.getByRole("button", { name: /Load video player/ }));
    expect(await screen.findByText(/does not allow it to play on other sites/)).toBeVisible();
    expect(screen.getByRole("link", { name: /open the video on YouTube/ })).toHaveAttribute("href", video.url);
    expect(screen.getByText(video.youtube.fallback.text)).toBeVisible();
    youtube.remove();
  });

  it.each([100, 101, 150])("player error %i falls back to the written route and keeps the lesson step (F08)", async (code) => {
    const youtube = installFakeYouTube(code);
    const client = createResourcesClient({
      request: (async (url: string) => (url.includes("/media?") ? { media: [], optional: true, grantsCredit: false } : body([video]))) as never,
    });
    render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    fireEvent.click(await screen.findByText("1 reviewed resource for this episode"));
    fireEvent.click(screen.getByRole("button", { name: /Load video player/ }));
    expect(await screen.findByText(/This video can’t play here/)).toBeVisible();
    expect(screen.getByText(/Your place in the lesson is kept, and nothing is marked as missed/)).toBeVisible();
    expect(screen.getByText(video.youtube.fallback.text)).toBeVisible();
    youtube.remove();
  });

  it("plays only the reviewed segment and marks a verified suggestion; malformed segments are dropped", async () => {
    const reviewed = { ...video, youtube: { ...video.youtube, segment: { startSeconds: 75, endSeconds: 3725 } }, suggestedFor: ["maximum"] };
    const parsed = parseResources(body([reviewed,
      { ...video, id: "x5", youtube: { ...video.youtube, segment: { startSeconds: 90, endSeconds: 30 } }, suggestedFor: ["<b>x</b>", 7] }]));
    expect(parsed[0]!.youtube?.segment).toEqual({ startSeconds: 75, endSeconds: 3725 });
    expect(parsed[0]!.suggestedFor).toEqual(["maximum"]);
    expect(parsed[1]!.youtube?.segment).toBeUndefined();
    expect(parsed[1]!.suggestedFor).toEqual([]);
    const youtube = installFakeYouTube();
    const client = createResourcesClient({
      request: (async (url: string) => (url.includes("/media?") ? { media: [], optional: true, grantsCredit: false } : body([reviewed, page]))) as never,
    });
    const { container } = render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    fireEvent.click(await screen.findByText("2 reviewed resources for this episode"));
    expect(screen.getAllByText(/Suggested for you/)).toHaveLength(1);
    expect(screen.getByText(/1:15–1:02:05/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Load video player/ }));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(youtube.calls[0]!.playerVars).toMatchObject({ autoplay: 0, start: 75, end: 3725 });
    youtube.remove();
  });

  it("shows an approved generated image with its alt text and no caption track", async () => {
    const picture = { id: "44444444-4444-4444-8444-444444444444", title: "Running minimum diagram", objective: "Shows the minimum.", generated: true,
      transcript: null, visualDescription: "Three boxes holding 5, 3 and 8; the box holding 3 is highlighted.", mimeType: "image/png",
      assetUrl: "https://evil.example/steal.png", captionsUrl: null, reviewedAt: "2026-10-13T10:00:00Z", expiresAt: "2026-11-13T10:00:00Z" };
    const parsed = parseGeneratedMedia({ media: [picture, { ...picture, mimeType: "image/svg+xml" }, { ...picture, visualDescription: "" }], optional: true, grantsCredit: false }, "e-1");
    expect(parsed).toEqual([expect.objectContaining({ mimeType: "image/png", captionsUrl: null, assetUrl: `/api/enrollments/e-1/media/${picture.id}/asset` })]);
    const client = createResourcesClient({
      request: (async (url: string) => (url.includes("/media?") ? { media: [picture], optional: true, grantsCredit: false } : body([]))) as never,
    });
    render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    fireEvent.click(await screen.findByText("1 reviewed resource for this episode"));
    const img = await screen.findByAltText(picture.visualDescription);
    expect(img.getAttribute("src")).toBe(`/api/enrollments/e-1/media/${picture.id}/asset`);
    expect(document.querySelector("video")).toBeNull();
  });

  it("shows approved course-made video with captions and a transcript, rebuilt for this enrollment only", async () => {
    const clip = { id: "33333333-3333-4333-8333-333333333333", title: "Running minimum in motion", objective: "Shows the running minimum.",
      generated: true, transcript: "The running minimum keeps the smaller value.", visualDescription: "A highlight moves along five boxes.",
      mimeType: "video/mp4", assetUrl: "https://evil.example/steal", captionsUrl: "https://evil.example/c.vtt",
      reviewedAt: "2026-10-13T10:00:00Z", expiresAt: "2026-11-13T10:00:00Z" };
    expect(() => parseGeneratedMedia({ media: [clip], optional: true, grantsCredit: true }, "e-1")).toThrow();
    const parsed = parseGeneratedMedia({ media: [clip, { ...clip, id: "not-a-uuid" }, { ...clip, generated: false }, { ...clip, mimeType: "text/html" }], optional: true, grantsCredit: false }, "e-1");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.assetUrl).toBe(`/api/enrollments/e-1/media/${clip.id}/asset`);
    const client = createResourcesClient({
      request: (async (url: string) => (url.includes("/media?") ? { media: [clip], optional: true, grantsCredit: false } : body([]))) as never,
    });
    const { container } = render(<EpisodeResources client={client} enrollmentId="e-1" episodeId="min" />);
    fireEvent.click(await screen.findByText("1 reviewed resource for this episode"));
    expect(screen.getByText(/Course-made video/)).toBeVisible();
    expect(screen.getByText(clip.transcript)).toBeVisible();
    expect(screen.getByText(clip.visualDescription)).toBeVisible();
    const player = container.querySelector("video")!;
    expect(player.getAttribute("preload")).toBe("none");
    expect(player.hasAttribute("autoplay")).toBe(false);
    expect(container.querySelector("source")!.getAttribute("src")).toBe(`/api/enrollments/e-1/media/${clip.id}/asset`);
    expect(container.querySelector("track")!.getAttribute("src")).toBe(`/api/enrollments/e-1/media/${clip.id}/captions.vtt`);
    expect(container.querySelector("track")!.getAttribute("kind")).toBe("captions");
  });

  it("stays out of the way when nothing is attached and reports failure without blocking", async () => {
    const empty = createResourcesClient({ request: (async (url: string) => (url.includes("/media?") ? { media: [], optional: true, grantsCredit: false } : body([]))) as never });
    const { container } = render(<EpisodeResources client={empty} enrollmentId="e" episodeId="min" />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
    const failing = createResourcesClient({ request: (async () => { throw new Error("offline"); }) as never });
    render(<EpisodeResources client={failing} enrollmentId="e" episodeId="min" />);
    await screen.findByText("Reviewed resources are unavailable right now");
  });
});
