import React, { useEffect, useId, useState } from "react";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Icon } from "../../components/icons/Icon.web";
import { courseContentAttributes } from "../../domain/contentLanguage";
import { useT } from "../../i18n";

/** The names of the three levels, in order. */
const LEVEL_NAMES = ["hintLadder.name.nudge", "hintLadder.name.nextStep", "hintLadder.name.example"] as const;

/** At most three levels (TUT-5): a nudge, the next step, a similar example. Never a fourth that
 * gives the answer away (no bottom-out hint). */
export const HINT_LEVELS = 3;
/** The third level also opens this long after the second, without another try. */
export const HINT_WAIT_MS = 20_000;

/** How far along the ladder the learner is on one question. */
export interface HintProgress {
  /** Levels shown so far (0 to 3). */
  shown: number;
  /** When the second level was shown (ms since the epoch). */
  secondShownAt?: number;
  /** Answers checked since the second level was shown. */
  triesAfterSecond: number;
}
export const NO_HINTS: HintProgress = { shown: 0, triesAfterSecond: 0 };

/** The question's hints as the ladder offers them: easiest first, three at most. */
export function hintLevels(hints: readonly string[] | undefined): readonly string[] {
  return (hints ?? []).filter((hint) => hint.trim()).slice(0, HINT_LEVELS);
}

/**
 * The next level the button offers, and whether it opens now: the first any time, the second after
 * the first, the third after one more try or 20 s after the second. Null once every level shows.
 */
export function nextHint(hints: readonly string[], progress: HintProgress, now: number): { level: number; count: number; locked: boolean } | null {
  const count = hints.length;
  if (progress.shown >= count) return null;
  const level = progress.shown + 1;
  const locked =
    level === 3 &&
    progress.triesAfterSecond < 1 &&
    (progress.secondShownAt === undefined || now - progress.secondShownAt < HINT_WAIT_MS);
  return { level, count, locked };
}

/**
 * The help row's hint button ("Hint 2 of 3"). A level that is not open yet stays focusable,
 * `aria-disabled`, and says why beside it; pressing it does nothing. It re-renders by itself when
 * the 20 s wait ends.
 */
export function HintButton({ hints, progress, onOpen }: { hints: readonly string[]; progress: HintProgress; onOpen: () => void }) {
  const t = useT();
  const reason = useId();
  const [now, setNow] = useState(() => Date.now());
  const next = nextHint(hints, progress, now);
  const waitUntil = next?.locked && progress.secondShownAt !== undefined ? progress.secondShownAt + HINT_WAIT_MS : undefined;
  useEffect(() => {
    if (waitUntil === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, waitUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [waitUntil]);
  if (!next) return null;
  return (
    <span className="cc-check-hint-step">
      <button
        type="button"
        className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-check-hint-button"
        aria-disabled={next.locked || undefined}
        aria-describedby={next.locked ? reason : undefined}
        onClick={() => {
          if (!next.locked) onOpen();
        }}
      >
        <Icon name="lightbulb" size={16} />
        <span>{t("hintLadder.button", { level: next.level, count: next.count })}</span>
      </button>
      {next.locked && (
        <span id={reason} className="cc-check-hint-locked">
          {t("hintLadder.locked")}
        </span>
      )}
    </span>
  );
}

/** The hints shown so far, in place under the help row (M17): each with its level and name. */
export function HintArea({ hints, shown, course }: { hints: readonly string[]; shown: number; course?: unknown }) {
  const t = useT();
  if (shown < 1) return null;
  return (
    <div className="cc-check-hints" role="group" aria-label={t("hintLadder.area")}>
      {hints.slice(0, shown).map((hint, index) => (
        <div key={index} className="cc-check-hint">
          <p className="cc-check-hint-label">
            {t("hintLadder.heading", { level: index + 1, count: hints.length, name: t(LEVEL_NAMES[index]!) })}
          </p>
          <div {...courseContentAttributes(course)}>
            <MarkdownContent markdown={hint} />
          </div>
        </div>
      ))}
    </div>
  );
}
