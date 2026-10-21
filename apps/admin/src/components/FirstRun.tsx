import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Sparkles } from "lucide-react";
import type { AdminClient, AdminSession } from "../domain/contracts";
import { AiServicesPage } from "./aiServices/AiServicesPage";
import { InstallCourse } from "./InstallCourse";
import { firstRunText } from "../text/firstRun";
import { pageLocale } from "../text/aiServices";
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
  const locale = useMemo(() => pageLocale(), []);
  const t = useMemo(() => firstRunText(locale), [locale]);
  const [view, setView] = useState<"welcome" | "course" | "ai">("welcome");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [view]);
  const back = (
    <button type="button" className="button quiet" onClick={() => setView("welcome")}>
      <ArrowLeft size={18} aria-hidden="true" className="flip-rtl" /> {t("back")}
    </button>
  );
  return (
    <main className="startup ai-first-run" lang={locale} dir={locale === "he" ? "rtl" : "ltr"}>
      {view === "welcome" && (
        <>
          <h1 tabIndex={-1} ref={heading}>
            {t("title")}
          </h1>
          <p>{t("intro")}</p>
          <p className="ai-muted" dir="auto">
            {t("workspace", { name: workspace.title })}
          </p>
          <div className="ai-grid">
            {client.coursePackages && (
              <section className="ai-section" aria-labelledby="first-run-course">
                <BookOpen size={24} aria-hidden="true" />
                <h2 id="first-run-course">1. {t("course.title")}</h2>
                <p>{t("course.body")}</p>
                <button type="button" className="button secondary" onClick={() => setView("course")}>
                  {t("course.button")}
                </button>
              </section>
            )}
            {client.aiServices && (
              <section className="ai-section" aria-labelledby="first-run-ai">
                <Sparkles size={24} aria-hidden="true" />
                <h2 id="first-run-ai">{client.coursePackages ? "2. " : ""}{t("ai.title")}</h2>
                <p>{t("ai.body")}</p>
                <button type="button" className="button primary" onClick={() => setView("ai")}>
                  {t("ai.button")}
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
            {t("ai.title")}
          </h1>
          <AiServicesPage workspaceId={workspace.id} port={client.aiServices} role={workspace.role} locale={locale} />
        </>
      )}
      {view === "course" && client.coursePackages && (
        <>
          {back}
          <h1 tabIndex={-1} ref={heading}>
            {t("course.title")}
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
