import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugInspector } from "../src/connected/DebugInspector.web";
import { createInspectorClient, inspectorUrl, parseInspectorAccess } from "../src/client/inspectorClient";
import { registerVisualRuntime } from "../src/client/inspectorBridge";
import type { VisualRuntime } from "@course-core/visuals/headless";

const enrollmentId = "11111111-2222-4333-8444-555555555555";
const available = { available: true as const, path: "/admin/inspector" };
function host(windowSize: "compact" | "medium" | "expanded", access: Parameters<typeof DebugInspector>[0]["access"] = available, blockId = "min-text") {
  return render(
    <div className="connected-host">
      <main data-connected-background>
        <p>Lesson text</p>
        <DebugInspector access={access} enrollmentId={enrollmentId} episodeId="min" blockId={blockId} windowSize={windowSize} />
      </main>
    </div>,
  );
}
afterEach(() => {
  delete window.courseInspectorBridge;
});

describe("debug inspector entry in the learner app", () => {
  it("renders nothing for an account the server did not authorize", () => {
    const { container } = host("expanded", { available: false });
    expect(screen.queryByRole("button", { name: /debug inspector/i })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(window.courseInspectorBridge).toBeUndefined();
  });

  it("accepts only the server's same-origin inspector path", async () => {
    expect(parseInspectorAccess({ available: true, path: "/admin/inspector" })).toEqual(available);
    for (const value of [{ available: true, path: "https://elsewhere.example/admin/inspector" }, { available: true, path: "//evil.example/x" },
      { available: true, path: "/admin/inspector?x=1" }, { available: "yes", path: "/admin/inspector" }, null, "available"])
      expect(parseInspectorAccess(value)).toEqual({ available: false });
    const request = vi.fn(async () => ({ available: false, permissions: [] }));
    const client = createInspectorClient({ request } as never);
    expect(await client.access(enrollmentId)).toEqual({ available: false });
    expect(request).toHaveBeenCalledWith(`/api/enrollments/${enrollmentId}/debug-inspector`, "GET", undefined, { signal: undefined });
    expect(inspectorUrl("/admin/inspector", { enrollmentId, episodeId: "min", blockId: "min-text" })).toBe(`/admin/inspector?enrollment=${enrollmentId}&episode=min&block=min-text`);
  });

  it("opens a side panel on expanded windows, framing the inspector at the current part, and closes back to the lesson", () => {
    host("expanded");
    const trigger = screen.getByRole("button", { name: "Debug inspector" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const panel = screen.getByRole("complementary", { name: "Debug inspector" });
    expect(panel).toHaveAttribute("data-placement", "is-side");
    expect(panel.querySelector("iframe")).toHaveAttribute("src", `/admin/inspector?enrollment=${enrollmentId}&episode=min&block=min-text`);
    expect(panel.querySelector("iframe")).toHaveAttribute("title", "Debug inspector for this lesson");
    // Non-modal: the lesson stays usable beside it.
    expect((document.querySelector("main") as HTMLElement).inert).toBeFalsy();
    expect(window.courseInspectorBridge?.version).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Close the debug inspector" }));
    expect(screen.queryByRole("complementary", { name: "Debug inspector" })).toBeNull();
    expect(window.courseInspectorBridge).toBeUndefined();
  });

  it("is a pane on medium windows and a full-screen dialog on compact ones, with the lesson inert under it", async () => {
    const medium = host("medium");
    fireEvent.click(screen.getByRole("button", { name: "Debug inspector" }));
    expect(screen.getByRole("complementary", { name: "Debug inspector" })).toHaveAttribute("data-placement", "is-pane");
    medium.unmount();
    host("compact");
    const trigger = screen.getByRole("button", { name: "Debug inspector" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Debug inspector" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-placement", "is-full");
    expect((document.querySelector("main") as HTMLElement).inert).toBe(true);
    expect(dialog.closest("main")).toBeNull();
    // Escape (here, or inside the frame through the bridge) closes it and the lesson resumes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((document.querySelector("main") as HTMLElement).inert).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Debug inspector" }));
  });

  it("gives the framed inspector the live visual runtime of the part the learner is on, and lets it close the panel", () => {
    const runtime = { subscribe: () => () => undefined } as unknown as VisualRuntime, experience = { id: "visual-1" };
    const unregister = registerVisualRuntime("min", "min-visual", runtime, experience);
    host("expanded", available, "min-visual");
    fireEvent.click(screen.getByRole("button", { name: "Debug inspector" }));
    expect(window.courseInspectorBridge!.visual("min", "min-visual")).toEqual({ runtime, experience });
    expect(window.courseInspectorBridge!.visual("min", "other")).toBeUndefined();
    unregister();
    expect(window.courseInspectorBridge!.visual("min", "min-visual")).toBeUndefined();
    act(() => window.courseInspectorBridge!.close());
    expect(screen.queryByRole("complementary", { name: "Debug inspector" })).toBeNull();
  });
});
