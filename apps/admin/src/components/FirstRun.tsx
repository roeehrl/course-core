import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Sparkles } from "lucide-react";
import type { AdminClient, AdminSession } from "../domain/contracts";
import { AiServicesPage } from "./aiServices/AiServicesPage";
import { InstallCourse } from "./InstallCourse";
import { useT } from "../i18n";
import "./aiServices/aiServices.css";

/**
 * What an owner or administrator sees before any course exists: install a course, or connect AI
 * services first. Both are workspace settings, so neither needs a course.
 */
export function FirstRun({
  client,
  workspace,
  onCourseInstalled,
}: {
  client: AdminClient;
  workspace: AdminSession["workspaces"][number];
  onCourseInstalled: (catalogId: string) => void;
}) {
  const t = useT();
  const [view, setView] = useState<"welcome" | "course" | "ai">("welcome");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [view]);
  const back = (
    <button
      type="button"
      className="button quiet"
      onClick={() => setView("welcome")}
    >
      <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" />{" "}
      {t("firstRun.back")}
    </button>
  );
  return (
    <main className="startup ai-first-run">
      {view === "welcome" && (
        <>
          <h1 tabIndex={-1} ref={heading}>
            {t("firstRun.title")}
          </h1>
          <p>{t("firstRun.intro")}</p>
          <p className="ai-muted" dir="auto">
            {t("firstRun.workspace", { name: workspace.title })}
          </p>
          <div className="ai-grid">
            {client.coursePackages && (
              <section
                className="ai-section"
                aria-labelledby="first-run-course"
              >
                <BookOpen size={24} aria-hidden="true" />
                <h2 id="first-run-course">1. {t("firstRun.course.title")}</h2>
                <p>{t("firstRun.course.body")}</p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setView("course")}
                >
                  {t("firstRun.course.button")}
                </button>
              </section>
            )}
            {client.aiServices && (
              <section className="ai-section" aria-labelledby="first-run-ai">
                <Sparkles size={24} aria-hidden="true" />
                <h2 id="first-run-ai">
                  {client.coursePackages ? "2. " : ""}
                  {t("firstRun.ai.title")}
                </h2>
                <p>{t("firstRun.ai.body")}</p>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => setView("ai")}
                >
                  {t("firstRun.ai.button")}
                </button>
              </section>
            )}
          </div>
        </>
      )}
      {view === "ai" && client.aiServices && (
        <>
          {back}
          <h1 tabIndex={-1} ref={heading}>
            {t("firstRun.ai.title")}
          </h1>
          <AiServicesPage
            workspaceId={workspace.id}
            port={client.aiServices}
            role={workspace.role}
          />
        </>
      )}
      {view === "course" && client.coursePackages && (
        <>
          {back}
          <h1 tabIndex={-1} ref={heading}>
            {t("firstRun.course.title")}
          </h1>
          <InstallCourse
            client={client}
            workspaceId={workspace.id}
            onFinished={(catalogId) => {
              if (catalogId) onCourseInstalled(catalogId);
              else setView("welcome");
            }}
          />
        </>
      )}
    </main>
  );
}
