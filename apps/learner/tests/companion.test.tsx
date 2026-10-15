import React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "react-native";
import { ConnectedCompanion } from "../src/components/ConnectedCompanion";
import { CompanionDock } from "../src/components/CompanionDock.web";
import {
  createCompanionClient,
  companionJobLabel,
  type CompanionContext,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../src/client/companionClient";
import { createCourseApi } from "../src/client/apiClient";
import { useCompanionConversation } from "../src/hooks/useCompanionConversation";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { connectedSnapshot } from "./connectedFixtures";
const context: CompanionContext = {
  enrollmentId: "e",
  courseDigest: "digest",
  snapshotRevision: 1,
  courseTitle: "Study",
  episodeId: "intro",
  episodeTitle: "Notice change",
  independentChallengeIds: ["active-check"],
};
const message: CompanionMessage = {
  id: "m",
  role: "learner",
  content: "Why does it change?",
  context: { episodeId: "intro" },
  created_at: "2026-01-01",
  job_state: "queued",
  job_id: "job",
};
const receipt = {
  messageId: "m",
  eventId: "event",
  revision: 2,
  state: "queued" as const,
  downgradedChallengeIds: ["active-check"],
};
afterEach(() => vi.useRealTimers());
describe("persisted companion integration", () => {
  it("requires a clear choice and never silently sets assessment assistance consent", async () => {
    const send = vi.fn().mockResolvedValue(receipt),
      change = vi.fn();
    render(
      <ConnectedCompanion
        context={context}
        messages={[]}
        episodeTitles={{ intro: "Notice change" }}
        draft="Question"
        onDraftChange={change}
        onSend={send}
        pending={false}
        loaded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep independent attempt" }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue("Question");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to practice & send" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledWith("Question", true));
    await waitFor(() => expect(change).toHaveBeenCalledWith(""));
    expect(screen.getByText(/Waiting for the companion service/)).toBeVisible();
  });
  it("shows actual saved messages, source lesson and configuration state without raw provider reasons", () => {
    render(
      <ConnectedCompanion
        context={context}
        messages={[
          {
            ...message,
            job_state: "waiting",
            job_reason: "configuration_missing",
          },
        ]}
        episodeTitles={{ intro: "Notice change" }}
        draft=""
        onDraftChange={() => {}}
        onSend={vi.fn()}
        pending={false}
        loaded
      />,
    );
    expect(screen.getByText("Why does it change?")).toBeVisible();
    expect(screen.getByText("From: Notice change")).toBeVisible();
    expect(screen.getByText(/Waiting for service configuration/)).toBeVisible();
    expect(
      companionJobLabel({
        ...message,
        job_state: "failed",
        job_reason: "secret-provider-token",
      }),
    ).not.toContain("secret");
  });
  it("keeps drafts on failed sends and sends no consent flag without an independent check", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline")),
      change = vi.fn();
    render(
      <ConnectedCompanion
        context={{ ...context, independentChallengeIds: [] }}
        messages={[]}
        episodeTitles={{}}
        draft="Keep me"
        onDraftChange={change}
        onSend={send}
        pending={false}
        loaded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Keep me", undefined),
    );
    expect(change).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue("Keep me");
  });
  it("calls implemented endpoints with CSRF, explicit consent, snapshot revision and idempotency", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [message] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    const client = createCompanionClient(
        createCourseApi({ fetch: fetcher, csrf: () => "csrf" }),
      ),
      abort = new AbortController();
    expect(await client.load("e", abort.signal)).toEqual([message]);
    // The read is cancellable: the caller's signal is combined with the page's own
    // (caller cancellation is covered in apiClient.test.ts).
    expect(fetcher.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    await client.send(connectedSnapshot(), {
      episodeId: "intro",
      content: "hello",
    });
    expect(fetcher.mock.calls[1]![0]).toBe(
      "/api/enrollments/enrollment-1/companion",
    );
    const payload = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(payload.expectedRevision).toBe(1);
    expect(payload.idempotencyKey).toBeTruthy();
    expect(payload).not.toHaveProperty("allowAssessmentAssistance");
  });
  it("polls modestly for saved queued work and aborts when context or account changes", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue([message]);
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    const { rerender, unmount } = renderHook(
      ({ id, open }) => useCompanionConversation(client, id, open, 1),
      { initialProps: { id: "a", open: false } },
    );
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(2);
    const oldSignal = load.mock.calls[1]![1] as AbortSignal;
    rerender({ id: "b", open: true });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {});
    expect(load.mock.calls.at(-1)?.[0]).toBe("b");
    unmount();
    expect((load.mock.calls.at(-1)![1] as AbortSignal).aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });
  it("keeps the same textarea through responsive changes and traps/restores drawer focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const renderDock = (wide: boolean, open: boolean) => (
      <CompanionDock wide={wide} open={open} onOpenChange={close}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    const { rerender } = render(renderDock(false, true));
    const input = screen.getByRole("textbox", { name: "Draft" });
    input.focus();
    (input as HTMLTextAreaElement).setSelectionRange(2, 5);
    rerender(renderDock(true, true));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(2);
    rerender(renderDock(false, true));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledWith(false);
    rerender(renderDock(false, false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    trigger.remove();
  });
  it("collapses the pane beside the lesson without unmounting the draft, and moves it into a sheet when the window narrows", async () => {
    const onOpen = vi.fn(), onCollapse = vi.fn();
    const renderDock = (wide: boolean, open: boolean, collapsed: boolean) => (
      <CompanionDock wide={wide} open={open} onOpenChange={onOpen} collapsed={collapsed} onCollapsedChange={onCollapse}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    const { rerender } = render(renderDock(true, false, false));
    const input = screen.getByRole("textbox", { name: "Draft" });
    expect(screen.getByRole("complementary", { name: "Your companion" })).toBeVisible();
    expect(document.querySelector(".connected-companion-trigger")).not.toBeVisible();
    const close = screen.getByRole("button", { name: "Close companion" });
    expect(close).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(close);
    expect(onCollapse).toHaveBeenLastCalledWith(true);
    rerender(renderDock(true, false, true));
    // Hidden, not removed: the draft keeps its value for when the pane returns.
    expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toBe(input);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Companion" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    await act(async () => {});
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(onCollapse).toHaveBeenLastCalledWith(false);
    rerender(renderDock(true, false, false));
    input.focus();
    // Narrowing to a compact window while typing keeps the learner in the companion.
    rerender(renderDock(false, false, false));
    expect(onOpen).toHaveBeenLastCalledWith(true);
    rerender(renderDock(false, true, false));
    expect(screen.getByRole("dialog", { name: "Your companion" })).toBeVisible();
    expect(input).toHaveFocus();
    // Widening with the sheet open shows the pane even if it had been collapsed.
    onCollapse.mockClear();
    rerender(renderDock(false, true, true));
    rerender(renderDock(true, true, true));
    expect(onCollapse).toHaveBeenCalledWith(false);
  });
  it("closes the sheet with Escape even from a React Native text input, which stops key events bubbling", () => {
    const close = vi.fn();
    render(
      <CompanionDock wide={false} open onOpenChange={close}>
        <TextInput accessibilityLabel="Message" defaultValue="Keep this" />
      </CompanionDock>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledWith(false);
  });
  it("isolates drafts by account and keeps them in memory when storage is denied", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
    const a = createConnectedDraftStore("a", store);
    a.write("lesson", "saved");
    expect(createConnectedDraftStore("a", store).read("lesson")).toBe("saved");
    expect(createConnectedDraftStore("b", store).read("lesson")).toBe("");
    const denied = createConnectedDraftStore("a", {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
      removeItem() {
        throw Error();
      },
    });
    denied.write("answer", "never lose");
    expect(denied.read("answer")).toBe("never lose");
    expect(denied.unavailable).toBe(true);
  });
});
