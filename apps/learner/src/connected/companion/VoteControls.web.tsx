import React, { useEffect, useId, useRef, useState } from "react";
import type { CompanionFeedback, CompanionMessage, CompanionVote } from "../../client/companionClient";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";

/** How long "Thanks, noted." stays after a vote or a report. */
export const THANKS_MS = 3000;

type Vote = CompanionFeedback["vote"];
export interface VoteState {
  /** The vote shown: the one being saved, else the saved one. */
  vote: Vote;
  reported: boolean;
  /** "Thanks, noted." is showing. */
  thanked: boolean;
  /** The optional "What was wrong?" field is open. */
  noteOpen: boolean;
  /** The last change was not saved (the vote went back to what it was). */
  failed: boolean;
  choose(vote: "helpful" | "not_helpful"): void;
  sendNote(comment: string): void;
  closeNote(): void;
  report(): void;
}

/**
 * Helpful / Not helpful on a companion reply (final design §3.7): the press shows at once
 * (`aria-pressed`) while it is saved; pressing the chosen one again takes the vote back. Once
 * saved, "Thanks, noted." shows for 3 s (the row says it where its Based on chip was). Not helpful
 * also opens an optional one-line field. A change that was not saved goes back and says so.
 */
export function useVoteState(message: CompanionMessage, save: ((input: CompanionVote) => Promise<CompanionFeedback>) | undefined): VoteState {
  const [optimistic, setOptimistic] = useState<{ vote: Vote } | null>(null);
  // What the last save returned, until the reply itself reads it back.
  const [confirmed, setConfirmed] = useState<CompanionFeedback | null>(null);
  const read = message.feedback ?? null;
  useEffect(() => setConfirmed(null), [read?.vote, read?.reported]);
  const saved = confirmed ?? read;
  const [thanked, setThanked] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const thanks = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Only the latest change counts when two are in flight.
  const sequence = useRef(0);
  useEffect(() => () => clearTimeout(thanks.current), []);
  const vote = optimistic ? optimistic.vote : saved?.vote ?? null;
  function thank() {
    clearTimeout(thanks.current);
    setThanked(true);
    thanks.current = setTimeout(() => setThanked(false), THANKS_MS);
  }
  function send(input: CompanionVote, shown: { vote: Vote } | null, after?: () => void) {
    if (!save) return;
    const mine = ++sequence.current;
    setFailed(false);
    if (shown) setOptimistic(shown);
    save(input).then(
      (result) => {
        if (mine !== sequence.current) return;
        setOptimistic(null);
        setConfirmed(result);
        thank();
        after?.();
      },
      () => {
        if (mine !== sequence.current) return;
        setOptimistic(null);
        setNoteOpen(false);
        setFailed(true);
      },
    );
  }
  return {
    vote,
    reported: saved?.reported ?? false,
    thanked,
    noteOpen,
    failed,
    choose(choice) {
      const next = vote === choice ? null : choice;
      setNoteOpen(next === "not_helpful");
      send({ vote: next }, { vote: next });
    },
    sendNote(comment) {
      const text = comment.trim();
      if (!text) return setNoteOpen(false);
      send({ vote: vote ?? "not_helpful", comment: text }, null, () => setNoteOpen(false));
    },
    closeNote: () => setNoteOpen(false),
    report() {
      send({ vote, report: true }, null);
    },
  };
}

/** The two vote buttons of the action row's icon group. */
export function VoteButtons({ state }: { state: VoteState }) {
  const t = useT();
  return (
    <>
      <IconButton icon="thumb-up" iconSize={16} className="cc-act-icon" label={t("voteControls.helpful")} pressed={state.vote === "helpful"} onClick={() => state.choose("helpful")} />
      <IconButton icon="thumb-down" iconSize={16} className="cc-act-icon" label={t("voteControls.notHelpful")} pressed={state.vote === "not_helpful"} onClick={() => state.choose("not_helpful")} />
    </>
  );
}

/** The optional "What was wrong?" field under the row after Not helpful; Esc closes it. */
export function VoteNote({ state, onClosed }: { state: VoteState; onClosed?: () => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  // Focus was in the field when it closed (sent, or a change not saved): it goes back to the row.
  const focused = useRef(false);
  useEffect(() => {
    if (state.noteOpen) field.current?.focus({ preventScroll: true });
    else if (focused.current) {
      focused.current = false;
      onClosed?.();
    }
  }, [state.noteOpen]);
  if (!state.noteOpen) return null;
  const close = () => {
    focused.current = false;
    state.closeNote();
    onClosed?.();
  };
  return (
    <form
      className="cc-act-note"
      role="group"
      aria-label={t("voteControls.note.group")}
      onFocus={() => (focused.current = true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focused.current = false;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        state.sendNote(text);
      }}
    >
      <label htmlFor={id} className="cc-ui-sr-only">{t("voteControls.note.label")}</label>
      <input
        ref={field}
        id={id}
        type="text"
        className="cc-act-note-field"
        dir="auto"
        maxLength={500}
        placeholder={t("voteControls.note.label")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
      />
      <button type="submit" className="cc-act-note-send">{t("voteControls.note.send")}</button>
    </form>
  );
}
