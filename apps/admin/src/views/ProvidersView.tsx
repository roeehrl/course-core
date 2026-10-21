import { useMemo } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { AiServicesPage } from "../components/aiServices/AiServicesPage";
import { aiTranslator, pageLocale, type AiKey } from "../text/aiServices";
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
  if (client.mode === "connected" && canConfigure && data.course.workspaceId && client.aiServices)
    return (
      <AiServicesPage
        workspaceId={data.course.workspaceId}
        port={client.aiServices}
        role={data.role === "owner" ? "owner" : "admin"}
      />
    );
  return <ReadOnlyAiServices data={data} demo={client.mode === "demo"} />;
}

const JOB_IDS: readonly string[] = ["companion", "supervisor", "research", "reviewer", "media"];
function ReadOnlyAiServices({ data, demo }: { data: CourseWorkspace; demo: boolean }) {
  const text = useMemo(() => aiTranslator(pageLocale()), []);
  const { t } = text;
  return (
    <div className="ai-page" lang={text.locale} dir={text.dir}>
      <p className="ai-intro">{demo ? t("readonly.demo") : t("readonly.body")}</p>
      <ul className="ai-connections">
        {data.providers.map((provider) => (
          <li className="ai-connection" key={provider.id}>
            <h2 className="ai-readonly-title" dir="auto">
              {JOB_IDS.includes(provider.id) ? t(`role.${provider.id}.name` as AiKey) : provider.name}
            </h2>
            <p dir="auto">
              {JOB_IDS.includes(provider.id) ? t(`role.${provider.id}.purpose` as AiKey) : provider.description}
            </p>
            <p className="ai-facts">
              <span className={`ai-pill ${provider.configuration === "configured" ? "ok" : "warn"}`}>
                {t(`readonly.status.${provider.configuration}` as AiKey)}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
