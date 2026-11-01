import React, { useId, useState } from "react";
import { useT, type MessageKey, type Translate } from "../../i18n";
import { Chip } from "../ui/Chip.web";
import type { TurnState } from "./turnState";

export interface SuggestedChip {
  label: string;
  /** `send`: sent as the learner's turn. `fill`: put in the message box to finish. */
  kind: "send" | "fill";
  /** What a fill chip puts in the box (its label otherwise). */
  text: string;
}

const send = (t: Translate, key: MessageKey): SuggestedChip => ({ label: t(key), kind: "send", text: t(key) });

/**
 * The chips under the latest reply (final design §3.7): answers when the reply asked the learner
 * something, follow-ups otherwise; "Show me how" after three question turns in a row (TUT-3); and
 * under a hint that stands in for a counted check's answer, "Here's my reasoning", which fills the
 * box. No chip asks for a counted check's answer.
 */
export function replyChips(turn: TurnState, t: Translate): SuggestedChip[] {
  const chips = turn.yourTurn
    ? [send(t, "replyChips.notSure"), send(t, "replyChips.hint"), send(t, "replyChips.example")]
    : [send(t, "replyChips.anotherWay"), send(t, "replyChips.example"), send(t, "replyChips.quiz")];
  if (turn.showMeHow) chips.push(send(t, "replyChips.showMeHow"));
  if (turn.withheldHint) chips.push({ label: t("replyChips.reasoning"), kind: "fill", text: t("replyChips.reasoningText") });
  return chips;
}

/** The starter chips of an empty thread (§3.10, G9): they fill the box and never send. */
export function starterChips(t: Translate): SuggestedChip[] {
  return (["replyChips.starter.explain", "replyChips.starter.practice", "replyChips.starter.summary"] as const).map((key) => ({
    label: t(key),
    kind: "fill",
    text: t(key),
  }));
}

/**
 * A row of chips, wrapping. When the composer zone would take more than 40 % of the thread
 * (§6 reflow), they fold behind "More suggestions".
 */
export function ChipRow({
  chips,
  onSend,
  onFill,
  folded = false,
  fresh = false,
  label,
}: {
  chips: readonly SuggestedChip[];
  onSend(text: string): void;
  onFill(text: string): void;
  folded?: boolean;
  /** Under a reply that just arrived: the chips fade in with it (M7). */
  fresh?: boolean;
  /** The group's name ("Suggested answers"). */
  label: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!chips.length) return null;
  const row = (
    <div className={`cc-chat-chips${fresh ? " is-fresh" : ""}`} role="group" aria-label={label} id={id}>
      {chips.map((chip) => (
        <Chip
          key={`${chip.kind}:${chip.label}`}
          label={chip.label}
          variant={chip.kind}
          onPress={() => (chip.kind === "send" ? onSend(chip.text) : onFill(chip.text))}
        />
      ))}
    </div>
  );
  if (!folded) return row;
  return (
    <div className="cc-chat-chips-folded">
      <button type="button" className="cc-ui-text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {t("replyChips.more")}
      </button>
      {open ? row : <div id={id} hidden />}
    </div>
  );
}
