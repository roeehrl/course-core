import { useState } from "react";

interface Edit<T> {
  value: T;
  /** The saved version the edit started from (or was kept over). */
  base: string;
  /** Saved: the edit gives way to the saved values as soon as they change. */
  settling: boolean;
}

/**
 * The edit state of a form over saved values that can change while it is open (a reload, a
 * save in another section, another person's change).
 *
 * Until the person edits, the form shows the saved values, derived rather than copied into
 * state in an effect: a copy effect still pending when the form appears (or when the data
 * reloads) runs after an edit made at that moment and overwrites it. Once edited, a reload
 * never overwrites the edit. When the saved version changes under an edit, `changedElsewhere`
 * is set so the form can offer to show the saved version or keep the edit, instead of
 * silently keeping either; saving stays disabled until the person chooses.
 *
 * `savedKey` identifies the saved version (by default the saved values themselves); pass it
 * when the shown values include suggestions that are not saved. The same hook lives in the
 * admin app (apps/admin/src/hooks/useEditableSnapshot.ts).
 */
export function useEditableSnapshot<T>(
  saved: T,
  savedKey: string = JSON.stringify(saved),
) {
  const [edit, setEdit] = useState<Edit<T> | null>(null);
  const live = (current: Edit<T> | null) =>
    current && !(current.settling && current.base !== savedKey)
      ? current
      : null;
  const current = live(edit);
  return {
    value: current ? current.value : saved,
    /** The person has edited since the saved values were last shown. */
    edited: current !== null,
    /** The saved version changed after the person started editing. */
    changedElsewhere:
      !!current && !current.settling && current.base !== savedKey,
    set(next: T | ((value: T) => T)) {
      setEdit((previous) => {
        const kept = live(previous),
          from = kept ? kept.value : saved;
        return {
          value:
            typeof next === "function" ? (next as (value: T) => T)(from) : next,
          base: kept ? kept.base : savedKey,
          settling: false,
        };
      });
    },
    /** Drops the edit and shows the saved values. */
    discard() {
      setEdit(null);
    },
    /** Keeps the edit over the newer saved version (saving then replaces it). */
    keep() {
      setEdit((previous) => previous && { ...previous, base: savedKey });
    },
    /** The edit was saved: it stays on screen until the reloaded values replace it. */
    settle() {
      setEdit((previous) => previous && { ...previous, settling: true });
    },
  };
}
export type EditableSnapshot<T> = ReturnType<typeof useEditableSnapshot<T>>;
