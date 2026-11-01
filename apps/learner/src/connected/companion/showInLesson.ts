import { companionBridge, lessonNavigator, type LessonTarget } from "./bridge";
import { companionOpen } from "./openState";

/**
 * Shows a place in the lesson from the companion ("Try question 1", "Back to Part 2", a lesson
 * source in "Based on"): the lesson scrolls to it, highlights it (M14) and focuses it when asked
 * (lessonNavigator). Beside the lesson the companion stays open; as a sheet it first drops to
 * Collapsed, and a sheet that still keeps the lesson out of reach (inert) closes. Another lesson
 * is opened first.
 */
export function showInLesson(target: LessonTarget, currentEpisodeId?: string) {
  if (target.episodeId && target.episodeId !== currentEpisodeId) companionBridge.navigate({ to: "lesson", episodeId: target.episodeId });
  const state = companionOpen.get();
  if (state.open && !state.docked) companionOpen.setDetent("collapsed");
  requestAnimationFrame(() => {
    const lesson = document.querySelector(".connected-main");
    if (!lesson?.closest("[inert]")) return void lessonNavigator.show(target);
    companionOpen.setSheetOpen(false);
    // The lesson takes focus once the sheet has let go of it.
    requestAnimationFrame(() => requestAnimationFrame(() => void lessonNavigator.show(target)));
  });
}
