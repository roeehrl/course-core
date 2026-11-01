import type React from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import type { LearnerNotifications } from "../Notifications.web";
import type { companionOpen as CompanionOpen } from "../companion/openState";

/** What a notification opens, as the bell hands it over. */
export type NotificationTarget = Parameters<React.ComponentProps<typeof LearnerNotifications>["onOpen"]>[0];

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

/**
 * Opens what a notification is about: its course's page, and the companion there for a reply
 * (the pane opens on request only on the course page).
 */
export function openNotificationTarget(target: NotificationTarget, host: NotificationHost) {
  void host
    .transact(async () => {
      await host.refresh(target.enrollmentId);
      host.setPreview(undefined);
      host.setEpisodeId(undefined);
      host.setPlacement(false);
      host.setView("learn");
      if (target.companion) host.companionOpen.open("notification", { surface: "course" });
    })
    .catch(() => {});
}
