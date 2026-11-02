import React, { useId, useState } from "react";
import type { CompanionProps } from "./Companion";
import { Icon } from "./icons/Icon.web";
import { Announcer, useAnnounce } from "../connected/ui/Announcer.web";
import { CompanionTurnFrame } from "../connected/ui/CompanionTurnFrame.web";
import { LongAnswerComposer } from "../connected/ui/LongAnswerComposer.web";
import { useT } from "../i18n";

export type { CompanionProps } from "./Companion";

/** The longest note kept. */
const NOTE_MAX = 4000;

/**
 * The demo's companion (`/demo`, final design §4.19), on the connected companion's own parts so
 * the demo shows the real design: it is the content of the real panel or sheet (CompanionDock,
 * through DemoCompanionDock.web.tsx, which gives it the header and its controls), the course's
 * authored guidance as a companion turn under the label line, "Show a hint" as a chip, and notes
 * to yourself in the long-answer composer pinned at the bottom. No AI is involved, and the first
 * line of the thread says so once.
 *
 * Notes are kept on this device as they are typed; Cmd/Ctrl+Enter or "Save note" saves the note
 * there too and says so.
 */
export function Companion({ step, lessonTitle, note, onNoteChange, mode }: CompanionProps) {
  return (
    <Announcer>
      <DemoCompanion step={step} lessonTitle={lessonTitle} note={note} onNoteChange={onNoteChange} mode={mode} />
    </Announcer>
  );
}

function DemoCompanion({ step, lessonTitle, note, onNoteChange, mode }: CompanionProps) {
  const t = useT();
  const announce = useAnnounce();
  const [hint, setHint] = useState(false);
  const id = useId();
  const saved = `${id}-saved`,
    hintId = `${id}-hint`;
  return (
    <div className="cc-note-demo">
      <div className="cc-note-demo-thread">
        <p className="cc-note-demo-intro">{t(mode === "demo" ? "companion.intro.demo" : "companion.intro.course")}</p>
        {lessonTitle && step && (
          <p className="cc-note-demo-place" dir="auto">
            {t("companion.placeLesson", { lesson: lessonTitle, step: step.title })}
          </p>
        )}
        <CompanionTurnFrame author="companion" label className="cc-note-demo-turn">
          <p className="cc-note-demo-prose" dir="auto">
            {step?.companion.idea ?? t("companion.idea")}
          </p>
          {step && (
            <div className="cc-note-demo-chips">
              {/* The chip's look (Chip.web.tsx), as a disclosure: it says whether the hint shows. */}
              <button
                type="button"
                className="cc-ui-chip is-send is-32"
                aria-expanded={hint}
                aria-controls={hintId}
                onClick={() => setHint((value) => !value)}
              >
                <Icon name="lightbulb" size={16} />
                <span className="cc-ui-chip-label">{t(hint ? "companion.hint.hide" : "companion.hint.show")}</span>
              </button>
            </div>
          )}
          {step && (
            <div id={hintId} className="cc-note-demo-hint" aria-live="polite">
              {hint && (
                <p className="cc-note-demo-prose" dir="auto">
                  {step.companion.hint}
                </p>
              )}
            </div>
          )}
        </CompanionTurnFrame>
      </div>
      <div className="cc-note-demo-notes">
        <LongAnswerComposer
          label={t("companion.notes.label")}
          value={note}
          onChange={(value) => onNoteChange(value.slice(0, NOTE_MAX))}
          onSubmit={() => {
            onNoteChange(note);
            announce(t("companion.notes.saved"));
          }}
          submitLabel={t("companion.notes.save")}
          placeholder={t("companion.notes.placeholder")}
          describedBy={saved}
          className="cc-note-demo-composer"
        />
        <p id={saved} className="cc-note-demo-saved">
          {t("companion.notes.saved")}
        </p>
      </div>
    </div>
  );
}
