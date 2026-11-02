import { useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { InstallCourse } from "./InstallCourse";
import { Dialog } from "./ui";
import { useT, type MessageKey } from "../i18n";

/**
 * Whether this person can install course packages into the workspace of the open course: an
 * owner or administrator who can edit the course, on a connected server that takes packages.
 * The same rule decides "Install a new version" on Course & releases.
 */
export function installAccess(
  client: AdminClient,
  data: Pick<CourseWorkspace, "role" | "permissions" | "course"> | undefined,
): { allowed: true } | { allowed: false; reason: MessageKey } {
  if (client.mode !== "connected" || !client.coursePackages)
    return { allowed: false, reason: "addCourse.reason.unavailable" };
  if (
    !data?.course.workspaceId ||
    !data.permissions.includes("course.write") ||
    !["owner", "admin"].includes(data.role ?? "")
  )
    return { allowed: false, reason: "addCourse.reason.role" };
  return { allowed: true };
}

/** Adds a course to the workspace: the package installer, then the new course opens. */
export function AddCourseDialog({
  client,
  workspaceId,
  currentCourseId,
  onClose,
  onOpenCourse,
  onCurrentChanged,
}: {
  client: AdminClient;
  workspaceId: string;
  currentCourseId: string;
  onClose: () => void;
  /** Opens the installed course (reloading the course list first). */
  onOpenCourse: (courseId: string) => void;
  /** The package was a new version of the open course: reload it. */
  onCurrentChanged: () => void;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      title={t("addCourse.title")}
      eyebrow={t("addCourse.eyebrow")}
      className="install-dialog"
      pending={pending}
      onClose={onClose}
    >
      <p className="muted">{t("addCourse.intro")}</p>
      <InstallCourse
        client={client}
        workspaceId={workspaceId}
        onPendingChange={setPending}
        onFinished={(catalogId) => {
          onClose();
          // A package for a course the workspace already has adds a version to it: open that one.
          if (catalogId && catalogId !== currentCourseId)
            onOpenCourse(catalogId);
          else if (catalogId) onCurrentChanged();
        }}
      />
    </Dialog>
  );
}
