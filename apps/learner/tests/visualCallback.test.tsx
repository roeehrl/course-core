import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { VisualBlock, type VisualContextChange } from "../src/components/VisualBlock.web";
import { fromVisualExperience, VisualRuntime } from "@course-core/visuals/headless";
import { visualContextFixture } from "./visualContext.fixture";

const source = { episodeId: "lesson-one", blockId: "diagram-one", episodeTitle: "Lesson one" };
const ready = (events: VisualContextChange[]) => {
  const event = [...events].reverse().find((event) => event.kind === "frame");
  if (!event || event.kind !== "frame") throw new Error("No frame callback");
  return event.context;
};
describe("actual visual context callbacks", () => {
  it("emits validated primitive state, public fingerprint, timeline and source without geometry", async () => {
    const experience = visualContextFixture(), events: VisualContextChange[] = [];
    const { rerender } = render(<VisualBlock experience={experience} source={source} onContextChange={(e) => events.push(e)} />);
    await waitFor(() => expect(ready(events).timeMs).toBe(0));
    expect(ready(events)).toEqual({ schemaVersion: 1, sceneVersion: 1, episodeId: source.episodeId, blockId: source.blockId, visualId: experience.id, rendererId: experience.rendererId, sceneFingerprint: new VisualRuntime(fromVisualExperience(experience)).exportReplay().sceneFingerprint, state: { amount: 2, enabled: true, mode: "linear" }, timeMs: 0, layout: "expanded", reducedMotion: false });
    expect(screen.getByText(/Current illustration · Lesson one · A measured change/)).toBeVisible();
    fireEvent.change(screen.getByRole("slider", { name: "Amount" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show result" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Rule" }), { target: { value: "square" } });
    fireEvent.change(screen.getByRole("slider", { name: "Timeline" }), { target: { value: "500" } });
    expect(ready(events).state).toEqual({ amount: 4, enabled: false, mode: "square" });
    expect(ready(events).timeMs).toBe(500);
    expect(Object.isFrozen(ready(events))).toBe(true);
    expect(Object.isFrozen(ready(events).state)).toBe(true);
    const count = events.length;
    rerender(<VisualBlock experience={structuredClone(experience)} source={{ ...source }} onContextChange={(e) => events.push(e)} />);
    expect(events).toHaveLength(count); // New callback identity cannot cause a notification loop.
    expect(screen.getByRole("slider", { name: "Amount" })).toHaveValue("4");
  });
  it("resets scope changes and invalidates old identities on replacement and unmount", async () => {
    const experience = visualContextFixture(), events: VisualContextChange[] = [];
    const onContextChange = (e: VisualContextChange) => events.push(e);
    const { rerender, unmount } = render(<VisualBlock experience={experience} source={source} onContextChange={onContextChange} />);
    fireEvent.change(screen.getByRole("slider", { name: "Amount" }), { target: { value: "4" } });
    rerender(<VisualBlock experience={experience} source={{ episodeId: "lesson-two", blockId: "diagram-two" }} onContextChange={onContextChange} />);
    await waitFor(() => expect(ready(events).episodeId).toBe("lesson-two"));
    expect(ready(events).state.amount).toBe(2);
    expect(events).toContainEqual({ kind: "unavailable", reason: "unmounted", source: { episodeId: source.episodeId, blockId: source.blockId, visualId: experience.id } });
    expect(events.at(-1)?.kind).toBe("frame");
    unmount();
    expect(events.at(-1)).toEqual({ kind: "unavailable", reason: "unmounted", source: { episodeId: "lesson-two", blockId: "diagram-two", visualId: experience.id } });
  });
  it("reports unsupported or missing-source context honestly and preserves fallback", () => {
    const experience = visualContextFixture(), onContextChange = vi.fn();
    const { rerender, container } = render(<VisualBlock experience={experience} onContextChange={onContextChange} />);
    expect(onContextChange).toHaveBeenLastCalledWith({ kind: "unavailable", source: null, reason: "missing-source" });
    rerender(<VisualBlock experience={{ ...experience, rendererId: "unknown-renderer" }} source={source} onContextChange={onContextChange} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getByText(experience.accessibility.description)).toBeVisible();
    expect(onContextChange.mock.calls.at(-1)?.[0].reason).toBe("unsupported");
    rerender(<VisualBlock experience={{ ...experience, scene: { script: "alert(1)" } }} source={source} onContextChange={onContextChange} />);
    expect(onContextChange.mock.calls.at(-1)?.[0].reason).toBe("unsupported");
  });
  it("can attach a callback after mounting without resetting the controls", () => {
    const experience = visualContextFixture(), events: VisualContextChange[] = [];
    const { rerender } = render(<VisualBlock experience={experience} source={source} />);
    fireEvent.change(screen.getByRole("slider", { name: "Amount" }), { target: { value: "5" } });
    rerender(<VisualBlock experience={experience} source={source} onContextChange={(e) => events.push(e)} />);
    expect(ready(events).state.amount).toBe(5);
  });
});
