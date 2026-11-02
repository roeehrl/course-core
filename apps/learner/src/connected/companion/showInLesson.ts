import { companionBridge, lessonNavigator, type LessonTarget } from "./bridge";
import { companionOpen } from "./openState";

/** Runs after the page has drawn what was just changed (two frames: the commit, then layout). */
const afterRender = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

/**
 * Focus view hides the lesson (§2.2), so a jump into it goes back beside the lesson first: the
 * panel takes its place again and the lesson comes back at the place it was left (CompanionDock),
 * before the jump moves it. True when it left focus view; the lesson shows once the page has
 * drawn that (afterRender).
 */
export function leaveFocusViewForLesson(): boolean {
  if (companionOpen.get().view !== "focus") return false;
  companionOpen.setView("docked");
  return true;
}

/**
 * Shows a place in the lesson from the companion ("Try question 1", "Back to Part 2", a lesson
 * source in "Based on", the anchor chip above a question): the lesson scrolls to it, highlights it
 * (M14) and focuses it when asked (lessonNavigator). Beside the lesson the companion stays open,
 * and focus view first goes back beside the lesson; as a sheet it first drops to Collapsed, and a
 * sheet that still keeps the lesson out of reach (inert) closes. Another lesson is opened first.
 */
export function showInLesson(target: LessonTarget, currentEpisodeId?: string) {
  if (target.episodeId && target.episodeId !== currentEpisodeId) companionBridge.navigate({ to: "lesson", episodeId: target.episodeId });
  if (leaveFocusViewForLesson()) return afterRender(() => void lessonNavigator.show(target));
  const state = companionOpen.get();
  if (state.open && !state.docked) companionOpen.setDetent("collapsed");
  requestAnimationFrame(() => {
    const lesson = document.querySelector(".connected-main");
    if (!lesson?.closest("[inert]")) return void lessonNavigator.show(target);
    companionOpen.setSheetOpen(false);
    // The lesson takes focus once the sheet has let go of it.
    afterRender(() => void lessonNavigator.show(target));
  });
}
