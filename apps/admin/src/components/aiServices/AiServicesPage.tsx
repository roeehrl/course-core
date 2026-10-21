import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import {
  AiServicesError,
  pageStatus,
  type AiPricing,
  type AiServicesPort,
  type Budgets,
  type Connections,
  type Draft,
  type EvalStatus,
  type Issue,
  type ProviderSetup,
  type SectionId,
} from "../../domain/aiServices";
import { aiTranslator, pageLocale, type AiKey, type AiLocale } from "../../text/aiServices";
import { Confirm, Message, TextContext, newKey, sectionAnchor } from "./shared";
import { ConnectionsSection } from "./ConnectionsSection";
import { ModelsSection } from "./ModelsSection";
import { PricesSection } from "./PricesSection";
import { SpendingSection } from "./SpendingSection";
import { CheckSection } from "./CheckSection";
import { AdvancedSection } from "./AdvancedSection";
import "./aiServices.css";

export interface AiData {
  setup: ProviderSetup;
  connections: Connections;
  draft: Draft | null;
  pricing: AiPricing | null;
  budgets: Budgets | null;
  evals: EvalStatus | null;
}
async function load(port: AiServicesPort, workspace: string, signal?: AbortSignal): Promise<AiData> {
  const optional = <T,>(p: Promise<T>) => p.catch((error: unknown) => (signal?.aborted ? Promise.reject(error) : null));
  const [setup, connections, draft, pricing, budgets, evals] = await Promise.all([
    port.setup(workspace, signal),
    port.connections(workspace, signal),
    port.currentDraft(workspace, signal),
    optional(port.pricing(workspace, signal)),
    optional(port.budgets(workspace, signal)),
    optional(port.evals(workspace, signal)),
  ]);
  return { setup, connections, draft, pricing, budgets, evals };
}
/** Turns a draft on; asks before stopping unfinished jobs. Resolves false when cancelled. */
export type Activate = (draft: { id: string; baseRevision: number }) => Promise<boolean>;
export interface SectionProps {
  workspaceId: string;
  port: AiServicesPort;
  data: AiData;
  owner: boolean;
  reload: () => Promise<void>;
  activate: Activate;
  onDirty: (dirty: boolean) => void;
}
const ISSUE_TEXT: Record<Issue["kind"], AiKey> = {
  connect: "issue.connect",
  keyProblem: "issue.keyProblem",
  models: "issue.models",
  notOn: "issue.notOn",
  check: "issue.check",
  prices: "issue.prices",
  spending: "issue.spending",
  learnerLimit: "issue.learnerLimit",
};
const SECTION_TITLES: Record<SectionId | "advanced", AiKey> = {
  connections: "section.connections",
  models: "section.models",
  prices: "section.prices",
  spending: "section.spending",
  check: "section.check",
  advanced: "section.advanced",
};

/**
 * Admin "AI services": one page, sections in the order the work is done (connections, models for
 * each job, prices, spending limits, quality check, advanced). Each section saves on its own and
 * shows its own status; the bar at the top says what is still missing, with links.
 */
export function AiServicesPage({
  workspaceId,
  port,
  role,
  locale = pageLocale(),
}: {
  workspaceId: string;
  port: AiServicesPort;
  role: "owner" | "admin";
  locale?: AiLocale;
}) {
  const text = useMemo(() => aiTranslator(locale), [locale]);
  const { t } = text;
  const [data, setData] = useState<AiData>();
  const [failed, setFailed] = useState(false);
  const [dirty, setDirty] = useState<Partial<Record<SectionId | "advanced", boolean>>>({});
  const [confirming, setConfirming] = useState<{ count: number; resolve: (go: boolean) => void }>();
  const loaded = useRef(false);
  const reload = useCallback(async () => {
    try {
      setData(await load(port, workspaceId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [port, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    load(port, workspaceId, controller.signal)
      .then((value) => {
        loaded.current = true;
        setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [port, workspaceId]);
  // Leaving with unsaved changes in any section asks first.
  const anyDirty = Object.values(dirty).some(Boolean);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);
  const activate: Activate = useCallback(
    async (draft) => {
      const run = (confirmCancelRunning: boolean) =>
        port.activate(workspaceId, draft.id, {
          expectedRevision: draft.baseRevision,
          idempotencyKey: newKey(),
          confirmCancelRunning,
        });
      try {
        await run(false);
        return true;
      } catch (error) {
        if (!(error instanceof AiServicesError) || error.code !== "PROVIDER_JOBS_RUNNING") throw error;
        const go = await new Promise<boolean>((resolve) =>
          setConfirming({ count: error.details?.count ?? 1, resolve }),
        );
        setConfirming(undefined);
        if (!go) return false;
        await run(true);
        return true;
      }
    },
    [port, workspaceId],
  );
  const dirtyFor = useMemo(() => {
    const handlers = {} as Record<SectionId | "advanced", (value: boolean) => void>;
    for (const id of Object.keys(SECTION_TITLES) as (SectionId | "advanced")[])
      handlers[id] = (value) => setDirty((current) => (current[id] === value ? current : { ...current, [id]: value }));
    return handlers;
  }, []);
  const status = data ? pageStatus(data) : null;
  const jump = (section: SectionId | "advanced") => (event: React.MouseEvent) => {
    event.preventDefault();
    const target = document.getElementById(sectionAnchor(section));
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  };
  const unsaved = (Object.keys(dirty) as (SectionId | "advanced")[]).filter((id) => dirty[id]);
  return (
    <TextContext.Provider value={text}>
      <div className="ai-page" lang={locale} dir={text.dir}>
        <header className="ai-page-header">
          <p className="ai-intro">{t("page.intro")}</p>
        </header>
        {!data && !failed && <p role="status">{t("page.loading")}</p>}
        {!data && failed && (
          <Message tone="error">
            {t("page.loadFailed")}{" "}
            <button type="button" className="button secondary" onClick={() => void reload()}>
              {t("page.retry")}
            </button>
          </Message>
        )}
        {data && status && (
          <>
            <div className={`ai-status-bar ${status.on ? "on" : "off"}`} role="status" aria-live="polite">
              {status.on ? (
                <CheckCircle2 size={22} aria-hidden="true" />
              ) : (
                <AlertTriangle size={22} aria-hidden="true" />
              )}
              <div>
                <strong>{status.on ? t("status.on") : t("status.off")}</strong>
                {status.on ? (
                  <p className="ai-status-detail">{t("status.onDetail")}</p>
                ) : (
                  <ul className="ai-issues">
                    {status.issues.map((issue) => (
                      <li key={issue.kind}>
                        <a href={`#${sectionAnchor(issue.section)}`} onClick={jump(issue.section)}>
                          {t(ISSUE_TEXT[issue.kind], "count" in issue ? { count: issue.count } : {})}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {unsaved.length > 0 && (
                  <p className="ai-unsaved">
                    {t("status.unsaved", { sections: text.list(unsaved.map((id) => t(SECTION_TITLES[id]))) })}
                  </p>
                )}
              </div>
            </div>
            <nav className="ai-toc" aria-label={t("page.sections")}>
              <ol>
                {(Object.keys(SECTION_TITLES) as (SectionId | "advanced")[]).map((id) => (
                  <li key={id}>
                    <a href={`#${sectionAnchor(id)}`} onClick={jump(id)}>
                      {t(SECTION_TITLES[id])}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <SectionsList
              data={data}
              status={status}
              dirty={dirty}
              props={{ workspaceId, port, data, owner: role === "owner", reload, activate }}
              dirtyFor={dirtyFor}
            />
          </>
        )}
        {confirming && (
          <Confirm
            title={t("confirm.title")}
            body={t("confirm.body", { count: confirming.count })}
            confirm={t("confirm.go")}
            onConfirm={() => confirming.resolve(true)}
            onCancel={() => confirming.resolve(false)}
          />
        )}
      </div>
    </TextContext.Provider>
  );
}
function SectionsList({
  status,
  dirty,
  props,
  dirtyFor,
}: {
  data: AiData;
  status: NonNullable<ReturnType<typeof pageStatus>>;
  dirty: Partial<Record<SectionId | "advanced", boolean>>;
  props: Omit<SectionProps, "onDirty">;
  dirtyFor: Record<SectionId | "advanced", (value: boolean) => void>;
}) {
  return (
    <div className="ai-sections">
      <ConnectionsSection {...props} state={status.sections.connections} unsaved={!!dirty.connections} onDirty={dirtyFor.connections} />
      <ModelsSection {...props} state={status.sections.models} unsaved={!!dirty.models} onDirty={dirtyFor.models} />
      <PricesSection {...props} state={status.sections.prices} unsaved={!!dirty.prices} onDirty={dirtyFor.prices} />
      <SpendingSection {...props} state={status.sections.spending} unsaved={!!dirty.spending} onDirty={dirtyFor.spending} />
      <CheckSection {...props} state={status.sections.check} unsaved={!!dirty.check} onDirty={dirtyFor.check} />
      <AdvancedSection {...props} unsaved={!!dirty.advanced} onDirty={dirtyFor.advanced} />
    </div>
  );
}
