import type { ServerSnapshot } from "../../client/apiClient";
import type { NotificationTarget } from "../Notifications.web";
import { companionBridge, lessonNavigator } from "../companion/bridge";
import type { companionOpen as CompanionOpen } from "../companion/openState";
import { MEDIA, matches } from "../ui/media";

export type { NotificationTarget } from "../Notifications.web";

/** What opening a notification may do on the page. */
export interface NotificationHost {
  transact: <T>(action: () => Promise<T>) => Promise<T>;
  refresh: (enrollmentId: string) => Promise<ServerSnapshot>;
  setPreview: (value: undefined) => void;
  setEpisodeId: (value: string | undefined) => void;
  setPlacement: (value: boolean) => void;
  setView: (value: "learn" | "profile" | "activity") => void;
  openEpisode: (episodeId: string) => void;
  companionOpen: typeof CompanionOpen;
}

/** Whether the learner's course still has the lesson, and it can be opened. */
function lessonInCourse(server: ServerSnapshot, episodeId: string) {
  return (
    server.course.chapters.some((chapter) => chapter.episodes.some((episode) => episode.id === episodeId)) &&
    !(server.inaccessibleEpisodeIds ?? []).includes(episodeId)
  );
}

/** Runs after the page has drawn what the host just changed (two frames: the commit, then layout). */
const afterRender = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

/**
 * Opens what a notification is about (final design §4.8). A reply goes to the lesson it came
 * from: the part it was asked about is shown and marked (lessonNavigator, held until the lesson
 * has mounted) and the companion opens with the start of the reply at the top of its thread. The
 * message box takes focus with a fine pointer only, so a touch keyboard does not cover the reply.
 * A reply whose lesson left the course, an older reply without its ids, and every other
 * notification open the course page (with the companion, for a reply).
 */
export function openNotificationTarget(target: NotificationTarget, host: NotificationHost) {
  void host
    .transact(async () => {
      const server = await host.refresh(target.enrollmentId);
      host.setPreview(undefined);
      host.setPlacement(false);
      const episodeId = target.episodeId && !target.lessonGone && lessonInCourse(server, target.episodeId) ? target.episodeId : undefined;
      if (episodeId) {
        host.openEpisode(episodeId);
        // The pane of the lesson about to show, not the course page's.
        if (target.companion) host.companionOpen.open("notification", { surface: "lesson" });
        if (target.blockId) lessonNavigator.show({ episodeId, blockId: target.blockId });
      } else {
        host.setEpisodeId(undefined);
        host.setView("learn");
        if (target.companion) host.companionOpen.open("notification", { surface: "course" });
      }
      if (!target.companion) return;
      // Once the companion shows, so its thread can bring the reply into view.
      afterRender(() =>
        companionBridge.compose({
          source: "notification",
          focus: !matches(MEDIA.coarse),
          ...(target.replyMessageId ? { revealMessageId: target.replyMessageId } : {}),
        }),
      );
    })
    .catch(() => {});
}
