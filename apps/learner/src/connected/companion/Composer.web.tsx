import React, { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import type { CompanionFocusState } from "../../client/companionFocus";
import { Icon } from "../../components/icons/Icon.web";
import { useI18n, useT } from "../../i18n";
import { CREDIT_LINE_ID, CreditNotice } from "../credit/CreditNotice.web";
import { createCompositionTracker, isSendKey, type CompositionTracker } from "../ui/keys";
import { useCoarsePointer } from "../ui/media";
import { AttachmentChips, attachments, removeLastAttachment } from "./AttachmentChips.web";
import { NoticeSlot } from "./NoticeSlot.web";
import type { Notice } from "./notices";
import { SendStopButton, type SendStopState } from "./SendStopButton.web";

/** The longest message the server takes. */
export const MESSAGE_MAX = 4000;
/** The character count shows from here (final design §3.6). */
export const COUNT_FROM = 3200;
/** After this many sends with the keyboard on a device, the key hint is not shown again. */
export const KEY_HINT_SENDS = 3;
const KEY_HINT_STORE = "course:companion-key-sends";
let memorySends = 0;
/** Keyboard sends on this device (localStorage; memory when storage is off). */
export function keyboardSends(): number {
  try {
    const stored = Number(window.localStorage.getItem(KEY_HINT_STORE) ?? "0");
    return Number.isFinite(stored) ? Math.max(stored, memorySends) : memorySends;
  } catch {
    return memorySends;
  }
}
export function countKeyboardSend() {
  memorySends = keyboardSends() + 1;
  try {
    window.localStorage.setItem(KEY_HINT_STORE, String(memorySends));
  } catch {
    // Storage is off: counted for this page only.
  }
}

/** Line limits of the growing message box: 8 in a panel (or 40 % of its height), 5 on a phone,
 * 3 in a short landscape window. In px at the 24 px line, padding included. */
export const COMPOSER_MAX_PX = { 8: 216, 5: 140, 3: 88 } as const;

export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  focus: CompanionFocusState;
  notice?: Notice;
  /** The credit line moved below the pill (a banner took the notice slot). */
  creditInMeta: boolean;
  button: SendStopState;
  /** A reply is on its way: Enter does nothing (Shift+Enter still makes a line). */
  running: boolean;
  onSend(byKeyboard: boolean): void;
  onStop(): void;
  /** The consent row (credit's SendConfirm) replaces the meta line. */
  confirm?: React.ReactNode;
  /** The pill is shown (not outside a lesson without a draft; not when every question is used). */
  showPill: boolean;
  maxLines: 8 | 5 | 3;
  server?: ServerSnapshot;
  episodeId?: string;
  now: number;
  onDraftChoice?(keep: "shown" | "other"): void;
  onShowRecovered?(): void;
}

export interface ComposerHandle {
  focus(): void;
  textarea(): HTMLTextAreaElement | null;
  pill(): HTMLElement | null;
}

/**
 * The composer zone (final design §3.6): one notice above the pill, the pill (attachment chips,
 * the growing message box and one round Send/Stop button, with a single focus ring around it all)
 * and one meta line below (the credit line when it moved, the key hint, the character count), or
 * the consent row in its place.
 *
 * Keys: Enter sends with a fine pointer and makes a line on a touch keyboard; Shift+Enter makes a
 * line; Cmd/Ctrl+Enter sends everywhere; nothing sends while an input method is composing; Enter
 * does nothing while a reply is on its way; Esc stops a running reply (and is then not passed on)
 * but never clears the text; Backspace in an empty box removes the attachment. The box is never
 * locked by something else the page is doing.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { value, onChange, placeholder, focus, notice, creditInMeta, button, running, onSend, onStop, confirm, showPill, maxLines, server, episodeId, now } = props;
  const t = useT();
  const i18n = useI18n();
  const coarse = useCoarsePointer();
  const box = useRef<HTMLTextAreaElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const ime = useRef<CompositionTracker | null>(null);
  const ids = useId();
  const noticeId = `${ids}-notice`, chipsId = `${ids}-chip`, countId = `${ids}-count`;
  const [focused, setFocused] = useState(false);
  const [sends, setSends] = useState(keyboardSends);
  useImperativeHandle(ref, () => ({
    focus: () => box.current?.focus({ preventScroll: true }),
    textarea: () => box.current,
    pill: () => pill.current,
  }));
  useEffect(() => {
    const tracker = createCompositionTracker(box.current);
    ime.current = tracker;
    return () => tracker.dispose();
  }, [showPill]);
  // Grows with its text up to its limit, then scrolls (a fallback where `field-sizing` is missing).
  useLayoutEffect(() => {
    const field = box.current;
    if (!field || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
    field.style.blockSize = "auto";
    field.style.blockSize = `${field.scrollHeight}px`;
  }, [value, showPill]);
  // The message box is described by what applies to the next message: the notice, the attached
  // place and the credit line, those that are on screen.
  const attached = attachments(focus, t);
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    const present = [noticeId, ...attached.map((item) => `${chipsId}-${item.key}`), CREDIT_LINE_ID].filter((id) => document.getElementById(id));
    if (present.length) field.setAttribute("aria-describedby", present.join(" "));
    else field.removeAttribute("aria-describedby");
  });
  const over = value.length - MESSAGE_MAX;
  const keyHint = !coarse && focused && value.trim().length > 0 && sends < KEY_HINT_SENDS && !creditInMeta;
  function send(byKeyboard: boolean) {
    if (button !== "ready" && button !== "offline") return;
    if (byKeyboard) {
      countKeyboardSend();
      setSends(keyboardSends());
    }
    onSend(byKeyboard);
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      // Stops a running reply; otherwise Esc belongs to the panel (close, leave focus view).
      if (running) {
        event.preventDefault();
        onStop();
      }
      return;
    }
    if (event.key === "Backspace" && !value && removeLastAttachment(focus)) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || ime.current?.isComposing(event)) return;
    if (!isSendKey(event, { touch: coarse })) return;
    event.preventDefault();
    if (running) return;
    send(true);
  }
  const count = over > 0
    ? (
        <span id={countId} className="cc-chat-count is-over">
          <Icon name="alert-circle" size={16} />
          {t("composer.over", { count: over })}
        </span>
      )
    : value.length >= COUNT_FROM
      ? <span className="cc-chat-count">{t("composer.count", { count: i18n.number(value.length), max: i18n.number(MESSAGE_MAX) })}</span>
      : null;
  const metaStart = creditInMeta
    ? <CreditNotice server={server} episodeId={episodeId} now={now} placement="meta" />
    : keyHint
      ? <span className="cc-chat-key-hint">{i18n.rich("composer.keyHint", undefined, { key: (children, key) => <bdi key={key}>{children}</bdi> })}</span>
      : null;
  return (
    <div className="cc-chat-composer" style={{ "--cc-composer-lines": String(maxLines), "--cc-composer-max": `${COMPOSER_MAX_PX[maxLines]}px` } as React.CSSProperties}>
      <NoticeSlot
        notice={notice}
        id={noticeId}
        server={server}
        episodeId={episodeId}
        now={now}
        {...(props.onDraftChoice ? { onDraftChoice: props.onDraftChoice } : {})}
        {...(props.onShowRecovered ? { onShowRecovered: props.onShowRecovered } : {})}
      />
      {showPill && (
        <>
          <div className="cc-chat-pill" ref={pill} data-has-chips={attached.length ? "true" : undefined}>
            <AttachmentChips focus={focus} idPrefix={chipsId} />
            <div className="cc-chat-field-row">
              <textarea
                ref={box}
                className="cc-chat-field"
                rows={1}
                value={value}
                dir={value ? "auto" : undefined}
                aria-label={t("connectedCompanion.draft.label")}
                placeholder={placeholder}
                enterKeyHint={coarse ? "enter" : "send"}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
              <SendStopButton
                state={button}
                onSend={() => send(false)}
                onStop={onStop}
                describedBy={button === "over" ? countId : button === "blocked" ? noticeId : undefined}
              />
            </div>
          </div>
          {confirm ?? (
            (metaStart || count) && (
              <div className="cc-chat-meta">
                <span className="cc-chat-meta-start">{metaStart}</span>
                {count}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
});
