import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { AiServicesPage } from "../components/aiServices/AiServicesPage";
import { useAiText, type AiKey } from "../components/aiServices/shared";
import "../components/aiServices/aiServices.css";

/**
 * "AI services" (formerly Providers). Owners and administrators who can configure providers on a
 * connected server get the full page; everyone else sees a read-only summary.
 */
export function ProvidersView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions?: WorkspaceActions;
}) {
  const canConfigure = data.permissions.includes("provider.configure");
  if (
    client.mode === "connected" &&
    canConfigure &&
    data.course.workspaceId &&
    client.aiServices
  )
    return (
      <AiServicesPage
        workspaceId={data.course.workspaceId}
        port={client.aiServices}
        role={data.role === "owner" ? "owner" : "admin"}
      />
    );
  return <ReadOnlyAiServices data={data} demo={client.mode === "demo"} />;
}

const JOB_IDS: readonly string[] = [
  "companion",
  "supervisor",
  "research",
  "reviewer",
  "media",
];
function ReadOnlyAiServices({
  data,
  demo,
}: {
  data: CourseWorkspace;
  demo: boolean;
}) {
  const text = useAiText();
  const { t } = text;
  return (
    <div className="ai-page">
      <p className="ai-intro">
        {demo ? t("aiServices.readonly.demo") : t("aiServices.readonly.body")}
      </p>
      <ul className="ai-connections">
        {data.providers.map((provider) => (
          <li className="ai-connection" key={provider.id}>
            <h2 className="ai-readonly-title" dir="auto">
              {JOB_IDS.includes(provider.id)
                ? t(`aiServices.role.${provider.id}.name` as AiKey)
                : provider.name}
            </h2>
            <p dir="auto">
              {JOB_IDS.includes(provider.id)
                ? t(`aiServices.role.${provider.id}.purpose` as AiKey)
                : provider.description}
            </p>
            <p className="ai-facts">
              <span
                className={`ai-pill ${provider.configuration === "configured" ? "ok" : "warn"}`}
              >
                {t(
                  `aiServices.readonly.status.${provider.configuration}` as AiKey,
                )}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
