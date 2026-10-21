import { useEffect, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  Cable,
  ClipboardCheck,
  Contact,
  ChevronRight,
  Gauge,
  History,
  Hourglass,
  Compass,
  FlaskConical,
  Bot,
  Clapperboard,
  Layers3,
  Library,
  ListChecks,
  Network,
  PanelTop,
  PlugZap,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import type { AdminClient, AdminSession } from "./domain/contracts";
import { useRemote, useWorkspace } from "./hooks/useAdmin";
import { Badge, Button, ErrorState, Loading, Notice } from "./components/ui";
import { CourseView } from "./views/CourseView";
import { EnrollmentsView } from "./views/EnrollmentsView";
import { PolicyView } from "./views/PolicyView";
import { AllowancesView } from "./views/AllowancesView";
import { ProvidersView } from "./views/ProvidersView";
import { FirstRun } from "./components/FirstRun";
import { RunsView } from "./views/RunsView";
import { ResearchView } from "./views/ResearchView";
import { PeopleView } from "./views/PeopleView";
import { ReviewsView } from "./views/ReviewsView";
import { MediaView } from "./views/MediaView";
import { OverviewView } from "./views/OverviewView";
import { AuditView } from "./views/AuditView";
import { PlacementView } from "./views/PlacementView";
import { SupervisionView } from "./views/SupervisionView";
import { StudyView } from "./views/StudyView";
import { AdminSectionView } from "./views/AdminSectionView";
import { ConceptMappingsView } from "./views/ConceptMappingsView";
import { PlatformView } from "./views/PlatformView";
import { IntegrationsView } from "./views/IntegrationsView";
import { useI18n, useT, type AdminTranslator, type MessageKey } from "./i18n";

export interface AdminAppProps {
  client: AdminClient;
}
const views = [
  { id: "overview", titleKey: "adminApp.nav.overview", icon: Gauge },
  { id: "course", titleKey: "adminApp.nav.course", icon: BookOpen },
  { id: "learners", titleKey: "adminApp.nav.learners", icon: UsersRound },
  { id: "reviews", titleKey: "adminApp.nav.reviews", icon: ClipboardCheck },
  { id: "placement", titleKey: "adminApp.nav.placement", icon: Compass },
  { id: "people", titleKey: "adminApp.nav.people", icon: Contact },
  { id: "policy", titleKey: "adminApp.nav.policy", icon: ShieldCheck },
  { id: "allowances", titleKey: "adminApp.nav.allowances", icon: Hourglass },
  { id: "mappings", titleKey: "adminApp.nav.mappings", icon: Network },
  { id: "research", titleKey: "adminApp.nav.research", icon: Library },
  { id: "media", titleKey: "adminApp.nav.media", icon: Clapperboard },
  { id: "providers", titleKey: "adminApp.nav.providers", icon: PlugZap },
  { id: "supervision", titleKey: "adminApp.nav.supervision", icon: Bot },
  { id: "studies", titleKey: "adminApp.nav.studies", icon: FlaskConical },
  { id: "runs", titleKey: "adminApp.nav.runs", icon: ScanSearch },
  { id: "audit", titleKey: "adminApp.nav.audit", icon: History },
  { id: "platform", titleKey: "adminApp.nav.platform", icon: Activity },
  { id: "integrations", titleKey: "adminApp.nav.integrations", icon: Cable },
] as const satisfies readonly {
  id: string;
  titleKey: MessageKey;
  icon: unknown;
}[];
/** A role code from the server as a label; unknown codes are shown as they are. */
export function roleLabel(i18n: AdminTranslator, role: string) {
  const key = `adminApp.role.${role}` as MessageKey;
  return i18n.has(key) ? i18n.t(key) : role;
}
/** A fixed view, or `section:<id>` for an admin section the live release declares. */
type ViewId = (typeof views)[number]["id"] | `section:${string}`;
export function AdminApp({ client }: AdminAppProps) {
  const t = useT();
  const session = useRemote((signal) => client.getSession(signal), [client]);
  // After installing a new course, reload the session and open that course.
  const [preferred, setPreferred] = useState<string>();
  const openCourse = (id: string) => {
    setPreferred(id);
    session.reload();
  };
  if (session.loading)
    return (
      <main className="startup">
        <Loading label={t("adminApp.opening")} />
      </main>
    );
  if (session.error)
    return (
      <main className="startup">
        <h1>{t("adminApp.title")}</h1>
        <ErrorState error={session.error} onRetry={session.reload} />
      </main>
    );
  if (!session.data?.courses.length) {
    // An owner or administrator can set up the workspace before any course exists.
    const workspace = session.data?.workspaces?.[0];
    if (workspace)
      return (
        <FirstRun
          client={client}
          workspace={workspace}
          onCourseInstalled={openCourse}
        />
      );
    return (
      <main className="startup">
        <h1>{t("adminApp.noAccess.title")}</h1>
        <p>{t("adminApp.noAccess.body")}</p>
      </main>
    );
  }
  return (
    <AdminWorkspace
      client={client}
      session={session.data}
      initialCourseId={preferred}
      onOpenCourse={openCourse}
    />
  );
}
function AdminWorkspace({
  client,
  session,
  initialCourseId,
  onOpenCourse,
}: {
  client: AdminClient;
  session: AdminSession;
  initialCourseId?: string | undefined;
  onOpenCourse: (id: string) => void;
}) {
  const [courseId, setCourseId] = useState(
    session.courses.find((course) => course.id === initialCourseId)?.id ??
      session.courses[0]!.id,
  );
  return (
    <CourseWorkspace
      key={`${session.actor.id}:${courseId}`}
      client={client}
      session={session}
      courseId={courseId}
      onCourseChange={setCourseId}
      onOpenCourse={onOpenCourse}
    />
  );
}
function CourseWorkspace({
  client,
  session,
  courseId,
  onCourseChange,
  onOpenCourse,
}: {
  client: AdminClient;
  session: AdminSession;
  courseId: string;
  onCourseChange: (id: string) => void;
  onOpenCourse: (id: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const actions = useWorkspace(client, courseId);
  const data = actions.workspace;
  const [view, setView] = useState<ViewId>("course");
  const heading = useRef<HTMLHeadingElement>(null);
  // Sections the live release declares and the server lets this role open.
  const declared = useRemote(
    (signal) =>
      client.adminSections
        ? client.adminSections.list(courseId, signal)
        : Promise.resolve(null),
    [client, courseId],
  );
  // Section titles are course content, declared by the release.
  const sectionNav = (declared.data?.sections ?? []).map((section) => ({
    id: `section:${section.id}` as ViewId,
    title: section.title,
    icon: SlidersHorizontal,
    content: true,
  }));
  // Platform and integrations are workspace operations for owners and administrators.
  const operator =
    Boolean(client.platform) &&
    ["owner", "admin"].includes(data?.role ?? session.actor.role);
  const navigation = [
    // A view whose port this client lacks (for example the demo) is not offered.
    ...views
      .filter((item) => item.id !== "allowances" || client.getAllowances)
      .filter(
        (item) =>
          operator || (item.id !== "platform" && item.id !== "integrations"),
      )
      .map((item) => ({
        ...item,
        title: t(item.titleKey),
        content: false,
      })),
    ...sectionNav,
  ];
  const activeView =
    navigation.find((item) => item.id === view) ??
    navigation.find((item) => item.id === "course")!;
  const sectionId =
    view.startsWith("section:") && sectionNav.some((item) => item.id === view)
      ? view.slice("section:".length)
      : null;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view, courseId]);
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        {t("adminApp.skipLink")}
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Layers3 size={22} aria-hidden="true" />
          </span>
          <span>
            <span lang="en" dir="ltr">
              {/* i18n-ignore: product name, not translated */}
              course<span className="brand-core">core</span>
            </span>
            <small>{t("adminApp.brandSection")}</small>
          </span>
        </div>
        <div className="workspace-label">
          <PanelTop size={15} aria-hidden="true" /> {t("adminApp.workspace")}
        </div>
        <nav aria-label={t("adminApp.navigation")} className="nav-links">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => {
                setView(item.id);
                actions.clear();
                heading.current?.focus({ preventScroll: true });
                window.scrollTo({ top: 0, behavior: "instant" });
              }}
              disabled={actions.pending}
            >
              <item.icon size={19} aria-hidden="true" />
              <span dir={item.content ? "auto" : undefined}>{item.title}</span>
              {view === item.id && (
                <ChevronRight
                  size={15}
                  className="nav-arrow flip-rtl"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ListChecks size={22} aria-hidden="true" />
          <strong>{t("adminApp.tagline.title")}</strong>
          <p>{t("adminApp.tagline.body")}</p>
          <div className="actor">
            <span className="actor-avatar">{session.actor.name.charAt(0)}</span>
            <div>
              <strong dir="auto">{session.actor.name}</strong>
              <small>{roleLabel(i18n, data?.role ?? session.actor.role)}</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="course-picker">
            <label htmlFor="course-select">{t("adminApp.course")}</label>
            <select
              id="course-select"
              dir="auto"
              value={courseId}
              onChange={(e) => onCourseChange(e.target.value)}
              disabled={actions.pending}
            >
              {session.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.id === data?.course.id
                    ? data.course.title
                    : course.title}
                </option>
              ))}
            </select>
          </div>
          <div className="tag-row">
            <Badge tone={client.mode === "demo" ? "gold" : "blue"}>
              {client.mode === "demo"
                ? t("adminApp.badge.demo")
                : t("adminApp.badge.connected")}
            </Badge>
            <Button
              kind="quiet"
              aria-label={t("adminApp.refresh")}
              disabled={actions.pending || actions.loading}
              onClick={actions.refresh}
            >
              <RefreshCw size={18} aria-hidden="true" />
            </Button>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="content"
          aria-busy={actions.pending || actions.loading}
        >
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {data?.course.category
                  ? t("adminApp.eyebrow", { category: data.course.category })
                  : t("adminApp.eyebrow", {
                      category: t("adminApp.workspace"),
                    })}
              </p>
              <h1
                tabIndex={-1}
                ref={heading}
                dir={activeView.content ? "auto" : undefined}
              >
                {activeView.title}
              </h1>
            </div>
            <div className="heading-meta">
              <Badge>{roleLabel(i18n, data?.role ?? session.actor.role)}</Badge>
              {data && (
                <small className="mono">
                  {t("adminApp.revision", { revision: data.revision })}
                </small>
              )}
            </div>
          </div>
          {session.deployment?.insecureOriginsAllowed && (
            <div className="deployment-notice">
              <Notice tone="red" title={t("adminApp.insecure.title")}>
                {t("adminApp.insecure.body")}
              </Notice>
            </div>
          )}
          {client.mode === "demo" && (
            <p className="demo-disclosure">{t("adminApp.demoDisclosure")}</p>
          )}
          {actions.loading ? (
            <Loading />
          ) : actions.loadError ? (
            <ErrorState error={actions.loadError} onRetry={actions.refresh} />
          ) : data ? (
            <div key={view}>
              {view === "course" && (
                <CourseView
                  data={data}
                  client={client}
                  actions={actions}
                  onOpenCourse={onOpenCourse}
                />
              )}
              {view === "learners" && (
                <EnrollmentsView
                  data={data}
                  client={client}
                  actions={actions}
                />
              )}
              {view === "policy" && (
                <PolicyView data={data} client={client} actions={actions} />
              )}
              {view === "allowances" && client.getAllowances && (
                <AllowancesView data={data} client={client} />
              )}
              {view === "providers" && (
                <ProvidersView data={data} client={client} actions={actions} />
              )}
              {view === "reviews" && (
                <ReviewsView data={data} client={client} />
              )}
              {view === "people" && <PeopleView data={data} client={client} />}
              {view === "research" && (
                <ResearchView data={data} client={client} />
              )}
              {view === "media" && <MediaView data={data} client={client} />}
              {view === "runs" && <RunsView data={data} client={client} />}
              {view === "overview" && (
                <OverviewView data={data} client={client} />
              )}
              {view === "audit" && <AuditView data={data} client={client} />}
              {view === "placement" && (
                <PlacementView data={data} client={client} />
              )}
              {view === "supervision" && (
                <SupervisionView data={data} client={client} />
              )}
              {view === "mappings" && <ConceptMappingsView client={client} />}
              {view === "studies" && <StudyView data={data} client={client} />}
              {view === "platform" && (
                <PlatformView data={data} client={client} />
              )}
              {view === "integrations" && (
                <IntegrationsView data={data} client={client} />
              )}
              {sectionId && client.adminSections && declared.data && (
                <AdminSectionView
                  key={sectionId}
                  port={client.adminSections}
                  data={data}
                  sectionId={sectionId}
                  list={declared.data}
                />
              )}
            </div>
          ) : (
            <Loading />
          )}
          <footer className="footer">
            <span>{t("adminApp.footer.motto")}</span>
            <span>{t("adminApp.footer.authorization")}</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
