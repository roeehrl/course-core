import React, { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Announcer, useAnnounce } from "../src/connected/ui/Announcer.web";
import { Chip } from "../src/connected/ui/Chip.web";
import { CompanionTurnFrame } from "../src/connected/ui/CompanionTurnFrame.web";
import { IconButton } from "../src/connected/ui/IconButton.web";
import { InlineConfirm } from "../src/connected/ui/InlineConfirm.web";
import { LongAnswerComposer } from "../src/connected/ui/LongAnswerComposer.web";
import { Menu } from "../src/connected/ui/Menu.web";
import { MetaLine } from "../src/connected/ui/MetaLine.web";
import { NoticeBanner } from "../src/connected/ui/NoticeBanner.web";
import { PanelHeader } from "../src/connected/ui/PanelHeader.web";
import { PillButton } from "../src/connected/ui/PillButton.web";
import { Popover } from "../src/connected/ui/Popover.web";
import { DOTS_STATIC_AFTER_MS, PreparingDots } from "../src/connected/ui/PreparingDots.web";
import { StatusLine } from "../src/connected/ui/StatusLine.web";
import { Tag } from "../src/connected/ui/Tag.web";
import { HIGHLIGHT_MS, RING_MS, highlightBlock, ringComposer } from "../src/connected/ui/highlight";
import { SAFARI_LATE_ENTER_MS, createCompositionTracker, isCompanionShortcut, isSendKey, isSubmitChord } from "../src/connected/ui/keys";

afterEach(() => vi.useRealTimers());

function matchMediaReturning(matching: string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matching.includes(query), addEventListener() {}, removeEventListener() {} }));
}

describe("keys", () => {
  it("sends on Enter with a fine pointer, Cmd/Ctrl+Enter always, never Shift+Enter or Alt", () => {
    expect(isSendKey({ key: "Enter" })).toBe(true);
    expect(isSendKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isSendKey({ key: "Enter", altKey: true })).toBe(false);
    expect(isSendKey({ key: "Enter" }, { touch: true })).toBe(false);
    expect(isSendKey({ key: "Enter", metaKey: true }, { touch: true })).toBe(true);
    expect(isSendKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSendKey({ key: "a" })).toBe(false);
    expect(isSubmitChord({ key: "Enter" })).toBe(false);
    expect(isSubmitChord({ key: "Enter", ctrlKey: true })).toBe(true);
  });

  it("treats an IME's Enter, and Safari's late Enter after compositionend, as composing", () => {
    let now = 1000;
    const field = document.createElement("textarea");
    const tracker = createCompositionTracker(field, () => now);
    expect(tracker.isComposing({ key: "Enter" })).toBe(false);
    expect(tracker.isComposing({ key: "Enter", keyCode: 229 })).toBe(true);
    expect(tracker.isComposing({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    field.dispatchEvent(new Event("compositionstart"));
    expect(tracker.isComposing({ key: "Enter" })).toBe(true);
    field.dispatchEvent(new Event("compositionend"));
    now += SAFARI_LATE_ENTER_MS - 1;
    expect(tracker.isComposing({ key: "Enter" })).toBe(true);
    now += 2;
    expect(tracker.isComposing({ key: "Enter" })).toBe(false);
    tracker.dispose();
  });

  it("reads the companion shortcut from the physical key, never with Alt", () => {
    expect(isCompanionShortcut({ code: "Period", key: ">", shiftKey: true, ctrlKey: true })).toBe(true);
    expect(isCompanionShortcut({ code: "Period", key: "ץ", shiftKey: true, metaKey: true })).toBe(true);
    expect(isCompanionShortcut({ code: "Period", shiftKey: true, ctrlKey: true, altKey: true })).toBe(false);
    expect(isCompanionShortcut({ code: "Period", ctrlKey: true })).toBe(false);
    expect(isCompanionShortcut({ code: "Comma", shiftKey: true, ctrlKey: true })).toBe(false);
  });
});

describe("highlight", () => {
  it("holds the block highlight 1400 ms, fades 600 ms, then removes it", () => {
    vi.useFakeTimers();
    matchMediaReturning([]);
    const el = document.createElement("div");
    highlightBlock(el);
    expect(el.getAttribute("data-cc-highlight")).toBe("hold");
    vi.advanceTimersByTime(HIGHLIGHT_MS.hold);
    expect(el.getAttribute("data-cc-highlight")).toBe("fade");
    vi.advanceTimersByTime(HIGHLIGHT_MS.fade);
    expect(el.hasAttribute("data-cc-highlight")).toBe(false);
  });

  it("holds 2 s without a fade under reduced motion, and restarts when marked again", () => {
    vi.useFakeTimers();
    matchMediaReturning(["(prefers-reduced-motion: reduce)"]);
    const el = document.createElement("div");
    highlightBlock(el);
    vi.advanceTimersByTime(1500);
    highlightBlock(el);
    vi.advanceTimersByTime(1999);
    expect(el.getAttribute("data-cc-highlight")).toBe("hold");
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute("data-cc-highlight")).toBe(false);
  });

  it("rings the composer 2000 ms and fades it 300 ms", () => {
    vi.useFakeTimers();
    matchMediaReturning([]);
    const el = document.createElement("div");
    const clear = ringComposer(el);
    vi.advanceTimersByTime(RING_MS.hold);
    expect(el.getAttribute("data-cc-ring")).toBe("fade");
    clear();
    expect(el.hasAttribute("data-cc-ring")).toBe(false);
  });
});

describe("announcer", () => {
  function Speaker() {
    const announce = useAnnounce();
    return (
      <>
        <button onClick={() => announce("Reply ready")}>ready</button>
        <button onClick={() => announce("Checking")}>checking</button>
      </>
    );
  }

  it("has its live region from the first render and says each change once", () => {
    render(
      <Announcer>
        <Speaker />
      </Announcer>,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
    fireEvent.click(screen.getByText("ready"));
    expect(region).toHaveTextContent("Reply ready");
    const node = region.firstChild;
    fireEvent.click(screen.getByText("ready"));
    expect(region.firstChild).toBe(node);
    fireEvent.click(screen.getByText("checking"));
    expect(region).toHaveTextContent("Checking");
  });
});

describe("menu", () => {
  function Actions({ onCopy }: { onCopy: () => void }) {
    return (
      <Menu
        label="Message actions"
        items={[
          { id: "copy", label: "Copy", icon: "copy", onSelect: onCopy },
          { id: "edit", label: "Edit", onSelect: () => {} },
          { id: "delete", label: "Delete", danger: true, onSelect: () => {} },
        ]}
        trigger={(props) => <IconButton icon="more-horizontal" label="More" {...props} />}
      />
    );
  }

  it("moves with the arrow keys, Home and End, runs an item and returns focus on Esc", async () => {
    const copy = vi.fn();
    const user = userEvent.setup();
    render(<Actions onCopy={copy} />);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    await user.click(more);
    expect(screen.getByRole("menu", { name: "Message actions" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
    await user.click(more);
    await user.keyboard("{Enter}");
    expect(copy).toHaveBeenCalledOnce();
    expect(more).toHaveFocus();
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Actions onCopy={() => {}} />
        <p>outside</p>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByText("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("popover", () => {
  function Info() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button ref={anchor} onClick={() => setOpen(true)}>
          About this
        </button>
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="About practice">
          <p>Practice does not count.</p>
          <button>Got it</button>
        </Popover>
        <p>elsewhere</p>
      </>
    );
  }

  it("is a non-modal dialog that takes focus, closes on Esc and returns focus", async () => {
    const user = userEvent.setup();
    render(<Info />);
    await user.click(screen.getByRole("button", { name: "About this" }));
    const dialog = screen.getByRole("dialog", { name: "About practice" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "About this" })).toHaveFocus();
  });

  it("closes on a click outside", async () => {
    const user = userEvent.setup();
    render(<Info />);
    await user.click(screen.getByRole("button", { name: "About this" }));
    await user.click(screen.getByText("elsewhere"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("inline confirm", () => {
  it("is a group named by its sentence, starts on the safe choice and takes it on Esc", async () => {
    const confirm = vi.fn(),
      cancel = vi.fn(),
      later = vi.fn();
    const user = userEvent.setup();
    render(
      <InlineConfirm
        sentence="This question will count as practice."
        confirmLabel="Send as practice"
        onConfirm={confirm}
        cancelLabel="Keep it counted"
        onCancel={cancel}
        tertiary={{ label: "Save for after the question", onPress: later }}
      />,
    );
    expect(screen.getByRole("group", { name: "This question will count as practice." })).toBeVisible();
    expect(screen.getByRole("button", { name: "Keep it counted" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(cancel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Save for after the question" }));
    expect(later).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("long-answer composer", () => {
  function Box({ onSubmit }: { onSubmit: () => void }) {
    const [value, setValue] = useState("");
    return <LongAnswerComposer label="Your answer" value={value} onChange={setValue} onSubmit={onSubmit} submitLabel="Submit" />;
  }

  it("makes a new line on Enter, submits on Ctrl+Enter, and never while composing", async () => {
    const submit = vi.fn();
    const user = userEvent.setup();
    render(<Box onSubmit={submit} />);
    const field = screen.getByRole("textbox", { name: "Your answer" });
    expect(field).toHaveAccessibleDescription("Ctrl+Enter to submit");
    await user.type(field, "first{Enter}second");
    expect(field).toHaveValue("first\nsecond");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(submit).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, SAFARI_LATE_ENTER_MS + 10));
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("shows the key hint to a fine pointer only: a touch keyboard has no ⌘ or Ctrl, the submit says how", async () => {
    matchMediaReturning(["(pointer: coarse)"]);
    const submit = vi.fn();
    const { container } = render(<Box onSubmit={submit} />);
    const field = screen.getByRole("textbox", { name: "Your answer" });
    expect(container.querySelector(".cc-ui-long-hint")).toBeNull();
    expect(screen.queryByText(/Enter to submit/)).toBeNull();
    expect(field).not.toHaveAttribute("aria-describedby");
    // The text submit stays the way to submit; a hardware keyboard's chord still works.
    fireEvent.change(field, { target: { value: "x" } });
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledOnce();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("does not submit an empty answer: the submit keeps its accent, and a press says what is missing", () => {
    const submit = vi.fn();
    render(<Box onSubmit={submit} />);
    const button = screen.getByRole("button", { name: "Submit" });
    // Like the check's "Check" (§4.1): focusable, aria-disabled, never greyed out.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveClass("cc-ui-pill-accent");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Write something here first.");
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/Write something here first\./);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button).not.toHaveAttribute("aria-disabled");
  });
});

describe("small pieces", () => {
  it("icon buttons are named, titled and toggle with aria-pressed", () => {
    render(<IconButton icon="maximize-2" label="Expand" pressed={false} />);
    const button = screen.getByRole("button", { name: "Expand" });
    expect(button).toHaveAttribute("title", "Expand");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("chips: a fill chip is described, a removable chip has its own remove button", async () => {
    const remove = vi.fn();
    render(
      <>
        <Chip variant="fill" label="Explain this another way" onPress={() => {}} />
        <Chip variant="removable" label="Question 1" onRemove={remove} removeLabel="Remove Question 1" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Explain this another way" })).toHaveAccessibleDescription("Fills in the message box");
    await userEvent.click(screen.getByRole("button", { name: "Remove Question 1" }));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("pill buttons, tags, status, meta and notice lines render their words and one action", async () => {
    const retry = vi.fn();
    render(
      <>
        <PillButton label="Ask again" startIcon="rotate-ccw" onPress={retry} />
        <Tag label="Your turn" variant="accent" />
        <StatusLine tone="error" text="The reply could not be finished." action={{ label: "Try again", onPress: retry }} />
        <MetaLine icon="practice" rule>
          Counts as practice
        </MetaLine>
        <NoticeBanner text="The companion can't see your screen." info={{ label: "More about this", text: "It reads only what you send." }} />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask again" }));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Your turn")).toHaveClass("cc-ui-tag", "is-accent");
    expect(document.querySelector('.cc-ui-status [data-icon="alert-circle"]')).not.toBeNull();
    expect(screen.getByText("Counts as practice")).toBeVisible();
    const info = screen.getByRole("button", { name: "More about this" });
    expect(screen.getByText("It reads only what you send.")).not.toBeVisible();
    await userEvent.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("It reads only what you send.")).toBeVisible();
  });

  it("preparing dots go still after 15 s", () => {
    vi.useFakeTimers();
    const { container } = render(<PreparingDots />);
    const dots = container.querySelector(".cc-ui-dots")!;
    expect(dots).toHaveAttribute("aria-hidden", "true");
    expect(dots).not.toHaveClass("is-still");
    act(() => vi.advanceTimersByTime(DOTS_STATIC_AFTER_MS));
    expect(dots).toHaveClass("is-still");
  });

  it("panel header and turn frame give the structure screen readers navigate by", () => {
    render(
      <>
        <PanelHeader title="Your companion" end={<IconButton icon="x" label="Close companion" />} />
        <CompanionTurnFrame author="learner">
          <p>Why 2?</p>
        </CompanionTurnFrame>
        <CompanionTurnFrame author="companion" label>
          <p>Compare them one by one.</p>
        </CompanionTurnFrame>
      </>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Your companion" })).toBeVisible();
    expect(screen.getByRole("article", { name: "You said" })).toHaveTextContent("Why 2?");
    expect(screen.getByRole("article", { name: "Companion said" })).toHaveTextContent("Companion");
  });
});
