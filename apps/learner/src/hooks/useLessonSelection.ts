import type { AskCandidate } from "../connected/companion/selectionAttach";

/** What the learner selected in the lesson and may ask the companion about. */
export interface LessonSelection {
  /** The selection the floating "Ask companion" button offers now (stable for 300 ms), or null. */
  candidate: AskCandidate | null;
  /** The shown selection was made with the keyboard (the status region names the shortcut). */
  viaKeyboard: boolean;
  /** The selection the learner could ask about this moment, shown or not (the shortcut). */
  current(): AskCandidate | null;
  /** Hides the button until the learner selects something else. */
  dismiss(): void;
}

/** Native: lesson selections are not offered to the companion yet. */
export function useLessonSelection(_enabled: boolean): LessonSelection {
  return { candidate: null, viaKeyboard: false, current: () => null, dismiss: () => {} };
}
