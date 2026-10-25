import { useEffect, useRef, useState, type ReactNode } from "react";
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
  Menu,
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
import { useStickyHeight } from "./hooks/useStickyHeight";
import { Badge, Button, ErrorState, Loading, Notice } from "./components/ui";
import { CourseView } from "./views/CourseView";
import { EnrollmentsView } from "./views/EnrollmentsView";
import { PolicyView } from "./views/PolicyView";
import { AllowancesView } from "./views/AllowancesView";
import { ProvidersView } from "./views/ProvidersView";
import { FirstRun } from "./components/FirstRun";
import { NotificationBell } from "./components/NotificationBell";
import { NavDrawer } from "./components/NavDrawer";
import { useFrameLayout } from "./hooks/useMediaQuery";
import { RunsView } from "./views/RunsView";
import { ResearchView } from "./views/ResearchView";
import { PeopleView } from "./views/PeopleView";
import { ReviewsView } from "./views/ReviewsView";
import { MediaView } from "./views/MediaView";
import { OverviewView } from "./views/OverviewView";
import { AuditView } from "./views/AuditView";
import { PlacementView } from "./views/PlacementView";
import { AssessmentsView } from "./views/AssessmentsView";
import { SupervisionView } from "./views/SupervisionView";
import { StudyView } from "./views/StudyView";
import { AdminSectionView } from "./views/AdminSectionView";
import { ConceptMappingsView } from "./views/ConceptMappingsView";
import { PlatformView } from "./views/PlatformView";
import { IntegrationsView } from "./views/IntegrationsView";
import { useI18n, useT, type AdminTranslator, type MessageKey } from "./i18n";

export interface AdminAppProps {
  client: AdminClient;
  /** The signed-in person's menu (connected host), shown at the end of the top bar. */
  account?: ReactNode;
}
const views = [
  { id: "overview", titleKey: "adminApp.nav.overview", icon: Gauge },
  { id: "course", titleKey: "adminApp.nav.course", icon: BookOpen },
  { id: "learners", titleKey: "adminApp.nav.learners", icon: UsersRound },
  { id: "reviews", titleKey: "adminApp.nav.reviews", icon: ClipboardCheck },
  { id: "assessments", titleKey: "adminApp.nav.assessments", icon: ListChecks },
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
/** The product name, as the sidebar and the startup header show it. */
function Brand() {
  const t = useT();
  return (
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
  );
}
/** Screens before a course workspace opens still carry the header with the account menu. */
function StartupHeader({ account }: { account?: ReactNode }) {
  if (!account) return null;
  return (
    <header className="startup-header">
      <Brand />
      {account}
    </header>
  );
}
export function AdminApp({ client, account }: AdminAppProps) {
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
      <>
        <StartupHeader account={account} />
        <main className="startup">
          <h1>{t("adminApp.title")}</h1>
          <ErrorState error={session.error} onRetry={session.reload} />
        </main>
      </>
    );
  if (!session.data?.courses.length) {
    // An owner or administrator can set up the workspace before any course exists.
    const workspace = session.data?.workspaces?.[0];
    if (workspace)
      return (
        <>
          <StartupHeader account={account} />
          <FirstRun
            client={client}
            workspace={workspace}
            onCourseInstalled={openCourse}
          />
        </>
      );
    return (
      <>
        <StartupHeader account={account} />
        <main className="startup">
          <h1>{t("adminApp.noAccess.title")}</h1>
          <p>{t("adminApp.noAccess.body")}</p>
        </main>
      </>
    );
  }
  return (
    <AdminWorkspace
      client={client}
      session={session.data}
      initialCourseId={preferred}
      onOpenCourse={openCourse}
      account={account}
    />
  );
}
function AdminWorkspace({
  client,
  session,
  initialCourseId,
  onOpenCourse,
  account,
}: {
  client: AdminClient;
  session: AdminSession;
  initialCourseId?: string | undefined;
  onOpenCourse: (id: string) => void;
  account?: ReactNode;
}) {
  const [courseId, setCourseId] = useState(
    session.courses.find((course) => course.id === initialCourseId)?.id ??
      session.courses[0]!.id,
  );
  // A notification on another course opens that course at the view it points to.
  const [initialView, setInitialView] = useState<ViewId>("course");
  return (
    <CourseWorkspace
      key={`${session.actor.id}:${courseId}`}
      client={client}
      session={session}
      courseId={courseId}
      initialView={initialView}
      onCourseChange={(id, view) => {
        setInitialView(view ?? "course");
        setCourseId(id);
      }}
      onOpenCourse={onOpenCourse}
      account={account}
    />
  );
}
function CourseWorkspace({
  client,
  session,
  courseId,
  initialView,
  onCourseChange,
  onOpenCourse,
  account,
}: {
  client: AdminClient;
  session: AdminSession;
  courseId: string;
  initialView: ViewId;
  onCourseChange: (id: string, view?: ViewId) => void;
  onOpenCourse: (id: string) => void;
  account?: ReactNode;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const actions = useWorkspace(client, courseId);
  const data = actions.workspace;
  const [view, setView] = useState<ViewId>(initialView);
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
  const workspaceId = data?.course.workspaceId;
  const courseTitles = new Map(
    session.courses.map((course) => [course.id, course.title]),
  );
  /** Opens the view a notification points to, on its course when that is another one. */
  const openTarget = (target: { view: string; courseId: string | null }) => {
    const known = navigation.find((item) => item.id === target.view);
    const next = (known?.id ?? "overview") as ViewId;
    if (
      target.courseId &&
      target.courseId !== courseId &&
      courseTitles.has(target.courseId)
    ) {
      onCourseChange(target.courseId, next);
      return;
    }
    actions.clear();
    setView(next);
  };
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
  // Wide windows keep the sidebar; phones and tablets get a top app bar and a navigation drawer.
  const layout = useFrameLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const appBar = useStickyHeight();
  // Where focus goes when the drawer closes: back to the menu button, or to the chosen page.
  const afterDrawer = useRef<"menu" | "heading">("menu");
  const drawerShown = drawerOpen && layout !== "wide";
  // A drawer left open when the window widens to the sidebar does not come back on narrowing.
  useEffect(() => {
    if (layout === "wide") setDrawerOpen(false);
  }, [layout]);
  const openView = (id: ViewId) => {
    setView(id);
    actions.clear();
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const navList = (onPick: (id: ViewId) => void) => (
    <nav aria-label={t("adminApp.navigation")} className="nav-links">
      {navigation.map((item) => (
        <button
          key={item.id}
          className={view === item.id ? "active" : ""}
          aria-current={view === item.id ? "page" : undefined}
          onClick={() => onPick(item.id)}
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
  );
  const courseTitle = (id: string, title: string) =>
    id === data?.course.id ? data.course.title : title;
  const coursePicker = (
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
            {courseTitle(course.id, course.title)}
          </option>
        ))}
      </select>
    </div>
  );
  const bell = client.notifications && workspaceId && (
    <NotificationBell
      port={client.notifications}
      workspaceId={workspaceId}
      courseTitles={courseTitles}
      onOpen={openTarget}
    />
  );
  const modeBadge = (
    <Badge tone={client.mode === "demo" ? "gold" : "blue"}>
      {client.mode === "demo"
        ? t("adminApp.badge.demo")
        : t("adminApp.badge.connected")}
    </Badge>
  );
  const refresh = (
    <Button
      kind="quiet"
      aria-label={t("adminApp.refresh")}
      disabled={actions.pending || actions.loading}
      onClick={actions.refresh}
    >
      <RefreshCw size={18} aria-hidden="true" />
    </Button>
  );
  const actor = (
    <div className="actor">
      <span className="actor-avatar">{session.actor.name.charAt(0)}</span>
      <div>
        <strong dir="auto">{session.actor.name}</strong>
        <small>{roleLabel(i18n, data?.role ?? session.actor.role)}</small>
      </div>
    </div>
  );
  const currentCourse = session.courses.find(
    (course) => course.id === courseId,
  );
  return (
    <div
      className={`app-frame ${layout === "wide" ? "" : `has-app-bar is-${layout}`}`.trim()}
    >
      <a className="skip-link" href="#main-content">
        {t("adminApp.skipLink")}
      </a>
      {layout === "wide" && (
        <aside className="sidebar">
          <Brand />
          <div className="workspace-label">
            <PanelTop size={15} aria-hidden="true" /> {t("adminApp.workspace")}
          </div>
          {navList(openView)}
          <div className="sidebar-bottom">
            <ListChecks size={22} aria-hidden="true" />
            <strong>{t("adminApp.tagline.title")}</strong>
            <p>{t("adminApp.tagline.body")}</p>
            {actor}
          </div>
        </aside>
      )}
      {drawerShown && (
        <NavDrawer
          id="nav-drawer"
          brand={<Brand />}
          onDismiss={() => {
            afterDrawer.current = "menu";
            setDrawerOpen(false);
          }}
          onClosed={() => {
            const target =
              afterDrawer.current === "heading"
                ? heading.current
                : menuButton.current;
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
        >
          {layout === "phone" && (
            <div className="nav-drawer-course">
              {coursePicker}
              {refresh}
            </div>
          )}
          <div className="workspace-label">
            <PanelTop size={15} aria-hidden="true" /> {t("adminApp.workspace")}
          </div>
          {navList((id) => {
            afterDrawer.current = "heading";
            setDrawerOpen(false);
            openView(id);
          })}
          <div className="nav-drawer-foot">
            {modeBadge}
            {actor}
          </div>
        </NavDrawer>
      )}
      <div className="workspace-main">
        {layout === "wide" ? (
          <header className="topbar">
            {coursePicker}
            <div className="tag-row">
              {bell}
              {modeBadge}
              {refresh}
              {account}
            </div>
          </header>
        ) : (
          <header className="topbar app-bar" ref={appBar}>
            <button
              ref={menuButton}
              type="button"
              className="nav-toggle"
              aria-label={t("adminApp.openMenu")}
              aria-haspopup="dialog"
              aria-expanded={drawerShown}
              aria-controls={drawerShown ? "nav-drawer" : undefined}
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={22} aria-hidden="true" />
            </button>
            <span className="app-bar-mark" aria-hidden="true">
              <Layers3 size={17} />
            </span>
            <div className="app-bar-title">
              <strong dir={activeView.content ? "auto" : undefined}>
                {activeView.title}
              </strong>
              {layout === "phone" && currentCourse && (
                <small dir="auto">
                  {courseTitle(currentCourse.id, currentCourse.title)}
                </small>
              )}
            </div>
            {layout === "tablet" && coursePicker}
            <div className="tag-row app-bar-actions">
              {bell}
              {layout === "tablet" && refresh}
              {account}
            </div>
          </header>
        )}
        <main
          id="main-content"
          tabIndex={-1}
          className="content"
          aria-busy={actions.pending || actions.loading}
        >
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {data?.course.category && !data.course.categoryCode
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
                <small className="heading-revision">
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
              {view === "assessments" && (
                <AssessmentsView data={data} client={client} />
              )}
              {view === "people" && <PeopleView data={data} client={client} />}
              {view === "research" && (
                <ResearchView data={data} client={client} />
              )}
              {view === "media" && <MediaView data={data} client={client} />}
              {view === "runs" && <RunsView data={data} client={client} />}
              {view === "overview" && (
                <OverviewView
                  data={data}
                  client={client}
                  onOpenAiServices={() => setView("providers")}
                />
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
