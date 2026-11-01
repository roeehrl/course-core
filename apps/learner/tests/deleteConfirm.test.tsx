import React, { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteConfirm } from "../src/connected/companion/DeleteConfirm.web";
import { BubbleActions } from "../src/connected/companion/BubbleActions.web";
import { companionBridge, resetCompanionBridge, type ComposeRequest } from "../src/connected/companion/bridge";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import type { CompanionMessage } from "../src/client/companionClient";

// Deleting a question (final design §3.7, §5): a 320 px confirm that starts on Cancel, Esc cancels,
// Delete in --danger, and a line when it could not; the learner's message menu around it.

function Harness({ onDelete, locale = "en" }: { onDelete: () => Promise<void>; locale?: "en" | "he" }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <I18nProvider value={createLearnerTranslator(locale)}>
      <button ref={anchor} type="button" onClick={() => setOpen(true)}>Open</button>
      <DeleteConfirm open={open} anchor={anchor} onCancel={() => setOpen(false)} onDelete={async () => { await onDelete(); setOpen(false); }} />
    </I18nProvider>
  );
}
const question: CompanionMessage = { id: "q", role: "learner", content: "Why isn't it 9?", context: {}, created_at: "2026-01-02T10:00:00Z", job_id: "job", job_state: "applied" };
afterEach(() => resetCompanionBridge());

describe("the delete confirm", () => {
  it("starts on Cancel, cancels on Esc and returns focus, and deletes with Delete", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(undefined);
    render(<Harness onDelete={remove} />);
    const open = screen.getByRole("button", { name: "Open" });
    await user.click(open);
    const dialog = screen.getByRole("dialog", { name: "Delete this question and its answer? Suggestions based on it are removed too. This can't be undone." });
    expect(dialog).toHaveClass("cc-ui-popover", "is-320");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(remove).toHaveBeenCalledOnce();
  });

  it("stays open and says so when the question could not be deleted", async () => {
    const user = userEvent.setup();
    render(<Harness onDelete={vi.fn().mockRejectedValue(new Error("offline"))} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del).toHaveClass("cc-act-delete");
    await user.click(del);
    expect(await screen.findByText("Couldn't delete the question. Refresh and try again.")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(del).toBeEnabled();
  });

  it("reads in Hebrew", async () => {
    const user = userEvent.setup();
    render(<Harness onDelete={vi.fn()} locale="he" />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "למחוק את השאלה ואת התשובה? גם הצעות שמבוססות עליה יוסרו. אי אפשר לבטל את זה." })).toBeVisible();
    expect(screen.getByRole("button", { name: "ביטול" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "מחיקה" })).toBeVisible();
  });
});

describe("the learner's message menu", () => {
  it("offers Edit and resend on the latest question after a stop, putting it back in the message box", async () => {
    const user = userEvent.setup();
    const requests: ComposeRequest[] = [];
    companionBridge.onCompose((request) => requests.push(request));
    const stopped = { ...question, job_state: "cancelled" };
    const { rerender } = render(<BubbleActions message={stopped} latest inProgress={false} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit and resend" }));
    expect(requests).toEqual([{ source: "edit", text: "Why isn't it 9?" }]);
    // Not on an answered question, nor on an older one.
    rerender(<BubbleActions message={question} latest inProgress={false} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Message options" }));
    expect(screen.queryByRole("menuitem", { name: "Edit and resend" })).toBeNull();
    await user.keyboard("{Escape}");
    rerender(<BubbleActions message={stopped} latest={false} inProgress={false} onDelete={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Message options" }));
    expect(screen.queryByRole("menuitem", { name: "Edit and resend" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Delete question" })).toBeVisible();
  });

  it("copies the question and says “Copied”, and notes a question later answers leave out", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<BubbleActions message={{ ...question, excluded: true }} latest inProgress={false} />);
    expect(screen.getByText("Not used in later answers")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Why isn't it 9?");
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });
});
