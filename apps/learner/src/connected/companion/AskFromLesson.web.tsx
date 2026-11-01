import { useLessonSelection } from "../../hooks/useLessonSelection";

/**
 * Asking the companion about something in the lesson: a selection in the lesson text, code or an
 * illustration is offered to the next message (companionFocus). Rendered once while the companion
 * is available.
 */
export function AskFromLesson(_props: { episodeId?: string }): null {
  useLessonSelection(true);
  return null;
}
