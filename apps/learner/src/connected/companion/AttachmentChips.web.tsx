import React from "react";
import { companionFocus, type CompanionFocusState } from "../../client/companionFocus";
import type { IconName } from "../../components/icons/icons";
import { useT, type Translate } from "../../i18n";
import { Chip } from "../ui/Chip.web";
import type { PlaceholderAttachment } from "./placeholder";

/** A quoted selection is cut here in its chip (final design §3.6). */
export const CHIP_EXCERPT = 60;
const clip = (text: string) => (text.length > CHIP_EXCERPT ? `${text.slice(0, CHIP_EXCERPT).trimEnd()}…` : text);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

interface Attachment {
  key: "check" | "selection" | "media";
  icon: IconName;
  label: string;
  remove: string;
  onRemove(): void;
}

/** What is attached to the next message, as chips (§3.9): a check, a selection, a video moment. */
export function attachments(focus: CompanionFocusState, t: Translate): Attachment[] {
  const list: Attachment[] = [];
  if (focus.check)
    list.push({
      key: "check",
      icon: "corner-down-left",
      label: t("attachmentChips.check", { number: focus.check.ordinal }),
      remove: t("attachmentChips.removeCheck"),
      onRemove: () => companionFocus.setCheck(undefined),
    });
  const selection = focus.selection;
  if (selection)
    list.push(
      selection.kind === "code"
        ? {
            key: "selection",
            icon: "code",
            label: selection.lineStart === selection.lineEnd
              ? t("attachmentChips.codeLine", { line: selection.lineStart })
              : t("attachmentChips.codeLines", { start: selection.lineStart, end: selection.lineEnd }),
            remove: t("attachmentChips.removeCode"),
            onRemove: () => companionFocus.setSelection(undefined),
          }
        : selection.kind === "visual_node"
          ? {
              key: "selection",
              icon: "image",
              label: t("attachmentChips.illustration", { label: selection.label }),
              remove: t("attachmentChips.removeIllustration"),
              onRemove: () => companionFocus.setSelection(undefined),
            }
          : {
              key: "selection",
              icon: "quote",
              label: t("attachmentChips.text", { excerpt: clip(selection.excerpt) }),
              remove: t("attachmentChips.removeText"),
              onRemove: () => companionFocus.setSelection(undefined),
            },
    );
  if (focus.media)
    list.push({
      key: "media",
      icon: "play",
      label: focus.media.playbackSeconds !== undefined
        ? t("attachmentChips.videoAt", { label: focus.media.label, time: clock(focus.media.playbackSeconds) })
        : focus.media.label,
      remove: t("attachmentChips.removeVideo"),
      onRemove: () => companionFocus.setMedia(undefined),
    });
  return list;
}

/** The kind of the first attachment, for the placeholder. */
export function placeholderAttachment(focus: CompanionFocusState): PlaceholderAttachment | undefined {
  if (focus.check) return { kind: "check", ordinal: focus.check.ordinal };
  if (focus.selection) return { kind: focus.selection.kind === "code" ? "code" : focus.selection.kind === "visual_node" ? "illustration" : "text" };
  if (focus.media) return { kind: "video" };
  return undefined;
}

/** Removes the newest attachment (Backspace in an empty message box, §3.6). */
export function removeLastAttachment(focus: CompanionFocusState): boolean {
  if (focus.media) companionFocus.setMedia(undefined);
  else if (focus.selection) companionFocus.setSelection(undefined);
  else if (focus.check) companionFocus.setCheck(undefined);
  else return false;
  return true;
}

/**
 * The attachment chips inside the pill, above the text: 28 px, an icon, a one-line label and a
 * remove button with its own name (§3.6, §3.9). `idPrefix` names each label, so the message box
 * can be described by them. `onRemoved` runs after a chip's × removed it, whose button goes with
 * it: the composer moves focus to the message box (§6).
 */
export function AttachmentChips({ focus, idPrefix, onRemoved }: { focus: CompanionFocusState; idPrefix: string; onRemoved?(): void }) {
  const t = useT();
  const list = attachments(focus, t);
  if (!list.length) return null;
  return (
    <div className="cc-chat-attachments">
      {list.map((item) => (
        <span key={item.key} id={`${idPrefix}-${item.key}`} className="cc-chat-attachment">
          <Chip variant="removable" size={28} icon={item.icon} label={item.label} removeLabel={item.remove} onRemove={() => {
            item.onRemove();
            onRemoved?.();
          }} />
        </span>
      ))}
    </div>
  );
}
