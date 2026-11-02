import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { OrganizationCeilingsCard } from "../components/OrganizationCeilingsCard";
import { Notice } from "../components/ui";
import { useT } from "../i18n";
import "./policy.css";

/**
 * The organization's outer limits, a workspace page: every course, learner, chapter and episode
 * below may only be stricter. The course's own settings stay on the course's Policy page.
 */
export function OrganizationLimitsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.getPolicyCeilings || !data.course.workspaceId) return null;
  return (
    <div className="page-stack policy-page">
      <OrganizationCeilingsCard
        client={client}
        workspaceId={data.course.workspaceId}
        canWrite={data.permissions.includes("policy.write")}
        denied={
          <Notice tone="gold">{t("organizationCeilingsCard.denied")}</Notice>
        }
      />
    </div>
  );
}
