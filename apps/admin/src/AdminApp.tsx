import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowLeft,
  BookCopy,
  BookOpen,
  Bot,
  Building2,
  Cable,
  ChevronRight,
  Clapperboard,
  ClipboardCheck,
  Compass,
  Contact,
  FlaskConical,
  Gauge,
  History,
  Hourglass,
  KeyRound,
  Layers3,
  Library,
  ListChecks,
  Menu,
  Network,
  PlugZap,
  RefreshCw,
  Scale,
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
import { CoursesHome } from "./views/CoursesHome";
import { OrganizationLimitsView } from "./views/OrganizationLimitsView";
import { CourseAccessView } from "./views/CourseAccessView";
import { CourseSwitcher } from "./components/CourseSwitcher";
import {
  adminBase,
  COURSE_HOME,
  isWorkspacePage,
  lastCourse,
  legacyRoute,
  parseAddress,
  rememberCourse,
  routePath,
  WORKSPACE_HOME,
  type AdminRoute,
  type PageId,
} from "./routing";
import { AddCourseDialog, installAccess } from "./components/AddCourse";
import { useI18n, useT, type AdminTranslator, type MessageKey } from "./i18n";
import "./shell.css";

export interface AdminAppProps {
  client: AdminClient;
  /** The signed-in person's menu (connected host), shown at the end of the top bar. */
  account?: ReactNode;
}
/** The sidebar's groups, in order. A workspace page and a course page never share a sidebar:
 * the workspace level lists the first two groups, a course the other three. Pairs that are easy
 * to confuse ("Answer reviews" and "Answer keys") land under different headings. */
const navGroups = [
  {
    id: "workspace",
    titleKey: "adminApp.navGroup.workspace",
    scope: "workspace",
  },
  { id: "server", titleKey: "adminApp.navGroup.server", scope: "workspace" },
  { id: "course", titleKey: "adminApp.navGroup.course", scope: "course" },
  { id: "learners", titleKey: "adminApp.navGroup.learners", scope: "course" },
  { id: "rules", titleKey: "adminApp.navGroup.rules", scope: "course" },
] as const satisfies readonly {
  id: string;
  titleKey: MessageKey;
  scope: AdminRoute["scope"];
}[];
type NavGroupId = (typeof navGroups)[number]["id"];
const views = [
  // The workspace: every course, and what applies to all of them.
  {
    id: "courses",
    titleKey: "adminApp.nav.courses",
    icon: BookCopy,
    group: "workspace",
  },
  {
    id: "people",
    titleKey: "adminApp.nav.people",
    icon: Contact,
    group: "workspace",
  },
  {
    id: "providers",
    titleKey: "adminApp.nav.providers",
    icon: PlugZap,
    group: "workspace",
  },
  {
    id: "supervision",
    titleKey: "adminApp.nav.supervision",
    icon: Bot,
    group: "workspace",
  },
  {
    id: "limits",
    titleKey: "adminApp.nav.limits",
    icon: Scale,
    group: "workspace",
  },
  {
    id: "mappings",
    titleKey: "adminApp.nav.mappings",
    icon: Network,
    group: "workspace",
  },
  {
    id: "audit",
    titleKey: "adminApp.nav.audit",
    icon: History,
    group: "workspace",
  },
  {
    id: "platform",
    titleKey: "adminApp.nav.platform",
    icon: Activity,
    group: "server",
  },
  {
    id: "integrations",
    titleKey: "adminApp.nav.integrations",
    icon: Cable,
    group: "server",
  },
  // One course.
  {
    id: "overview",
    titleKey: "adminApp.nav.overview",
    icon: Gauge,
    group: "course",
  },
  {
    id: "course",
    titleKey: "adminApp.nav.course",
    icon: BookOpen,
    group: "course",
  },
  {
    id: "assessments",
    titleKey: "adminApp.nav.assessments",
    icon: ListChecks,
    group: "course",
  },
  {
    id: "placement",
    titleKey: "adminApp.nav.placement",
    icon: Compass,
    group: "course",
  },
  {
    id: "research",
    titleKey: "adminApp.nav.research",
    icon: Library,
    group: "course",
  },
  {
    id: "media",
    titleKey: "adminApp.nav.media",
    icon: Clapperboard,
    group: "course",
  },
  {
    id: "learners",
    titleKey: "adminApp.nav.learners",
    icon: UsersRound,
    group: "learners",
  },
  {
    id: "reviews",
    titleKey: "adminApp.nav.reviews",
    icon: ClipboardCheck,
    group: "learners",
  },
  {
    id: "allowances",
    titleKey: "adminApp.nav.allowances",
    icon: Hourglass,
    group: "learners",
  },
  {
    id: "policy",
    titleKey: "adminApp.nav.policy",
    icon: ShieldCheck,
    group: "rules",
  },
  {
    id: "access",
    titleKey: "adminApp.nav.access",
    icon: KeyRound,
    group: "rules",
  },
  {
    id: "studies",
    titleKey: "adminApp.nav.studies",
    icon: FlaskConical,
    group: "rules",
  },
  {
    id: "runs",
    titleKey: "adminApp.nav.runs",
    icon: ScanSearch,
    group: "rules",
  },
] as const satisfies readonly {
  id: PageId;
  titleKey: MessageKey;
  icon: unknown;
  group: NavGroupId;
}[];
const groupScope = (group: NavGroupId) =>
  navGroups.find((item) => item.id === group)!.scope;
/** A role code from the server as a label; unknown codes are shown as they are. */
export function roleLabel(i18n: AdminTranslator, role: string) {
  const key = `adminApp.role.${role}` as MessageKey;
  return i18n.has(key) ? i18n.t(key) : role;
}
/** A fixed view, or `section:<id>` for an admin section the live release declares. */
type ViewId = PageId;
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
  // After installing a new course: its address first, then the session again (the new course
  // is in it), and the workspace opens on that course.
  const openCourse = (id: string) => {
    const base = adminBase(window.location.pathname);
    window.history.pushState(
      null,
      "",
      routePath({ scope: "course", courseId: id, page: COURSE_HOME }, base) +
        window.location.search,
    );
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
      onOpenCourse={openCourse}
      account={account}
    />
  );
}

const readLocation = () => ({
  pathname: window.location.pathname,
  search: window.location.search,
  hash: window.location.hash,
});
/** The query string to keep on a new address (`?locale=` stays; an older `?view=` does not). */
function keptSearch(search: string) {
  const params = new URLSearchParams(search);
  params.delete("view");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The page the address names, and the course it is read through. Workspace pages read the
 * workspace through the course used last (the server's administration routes are per course);
 * nothing about that course shows on them.
 */
function AdminWorkspace({
  client,
  session,
  onOpenCourse,
  account,
}: {
  client: AdminClient;
  session: AdminSession;
  onOpenCourse: (id: string) => void;
  account?: ReactNode;
}) {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const changed = () => setLocation(readLocation());
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const base = adminBase(location.pathname);
  const actorId = session.actor.id;
  const known = (id: string | null): id is string =>
    id !== null && session.courses.some((course) => course.id === id);
  const remembered = lastCourse(actorId);
  const last = known(remembered) ? remembered : null;
  const parsed = parseAddress(
    location.pathname,
    location.search,
    location.hash,
    base,
  ).route;
  let route: AdminRoute;
  if (!parsed)
    // The app's own address: the course used last, or the Courses home.
    route = last
      ? { scope: "course", courseId: last, page: COURSE_HOME }
      : { scope: "workspace", page: WORKSPACE_HOME };
  else if (parsed.scope === "workspace") route = parsed;
  else {
    const courseId = parsed.courseId ?? last ?? session.courses[0]!.id;
    // A course this person cannot open (or no longer exists) leaves them on the Courses home.
    route = known(courseId)
      ? { scope: "course", courseId, page: parsed.page }
      : { scope: "workspace", page: WORKSPACE_HOME };
  }
  const path = routePath(route, base);
  // Older and partial addresses are replaced with the page's own, so back and reload agree.
  useEffect(() => {
    if (window.location.pathname === path) return;
    window.history.replaceState(
      null,
      "",
      path + keptSearch(window.location.search),
    );
    setLocation(readLocation());
  }, [path]);
  const courseRoute = route.scope === "course" ? route.courseId : null;
  useEffect(() => {
    if (courseRoute) rememberCourse(actorId, courseRoute);
  }, [actorId, courseRoute]);
  const navigate = useCallback(
    (next: AdminRoute, options: { replace?: boolean } = {}) => {
      const target = routePath(next, adminBase(window.location.pathname));
      if (target === window.location.pathname) return;
      window.history[options.replace ? "replaceState" : "pushState"](
        null,
        "",
        target + keptSearch(window.location.search),
      );
      setLocation(readLocation());
    },
    [],
  );
  const courseId = courseRoute ?? last ?? session.courses[0]!.id;
  return (
    <CourseWorkspace
      key={`${actorId}:${courseId}`}
      client={client}
      session={session}
      courseId={courseId}
      route={route}
      lastCourseId={last}
      navigate={navigate}
      onOpenCourse={onOpenCourse}
      account={account}
    />
  );
}

function CourseWorkspace({
  client,
  session,
  courseId,
  route,
  lastCourseId,
  navigate,
  onOpenCourse,
  account,
}: {
  client: AdminClient;
  session: AdminSession;
  /** The open course, or on a workspace page the course the workspace is read through. */
  courseId: string;
  route: AdminRoute;
  lastCourseId: string | null;
  navigate: (route: AdminRoute, options?: { replace?: boolean }) => void;
  onOpenCourse: (id: string) => void;
  account?: ReactNode;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const actions = useWorkspace(client, courseId);
  const data = actions.workspace;
  const level = route.scope;
  const view: ViewId = route.page;
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
    group: "course" as NavGroupId,
  }));
  // Platform and integrations are workspace operations for owners and administrators.
  const operator =
    Boolean(client.platform) &&
    ["owner", "admin"].includes(data?.role ?? session.actor.role);
  const people = client.people;
  const offered = (id: PageId) => {
    // A page whose port this client lacks (for example the demo) is not offered.
    if (id === "allowances") return Boolean(client.getAllowances);
    if (id === "limits") return Boolean(client.getPolicyCeilings);
    if (id === "access")
      return Boolean(people?.grants && people.grant && people.revokeGrant);
    if (id === "platform" || id === "integrations") return operator;
    return true;
  };
  const navigation = [
    ...views
      .filter((item) => groupScope(item.group) === level && offered(item.id))
      .map((item) => ({
        ...item,
        title: t(item.titleKey),
        content: false,
      })),
    ...(level === "course" ? sectionNav : []),
  ];
  const workspaceId = data?.course.workspaceId;
  const courseTitles = new Map(
    session.courses.map((course) => [course.id, course.title]),
  );
  const home: AdminRoute =
    level === "course"
      ? { scope: "course", courseId, page: COURSE_HOME }
      : { scope: "workspace", page: WORKSPACE_HOME };
  /** Opens a page: a workspace page, or a page of the open course. */
  const openView = (id: ViewId) => {
    actions.clear();
    // The heading takes focus also when the page is the one already open.
    heading.current?.focus({ preventScroll: true });
    navigate(
      isWorkspacePage(id)
        ? { scope: "workspace", page: id }
        : { scope: "course", courseId, page: id },
    );
  };
  /** Another course, on the same page when that course has it (a declared section may not). */
  const switchCourse = (id: string) =>
    navigate({
      scope: "course",
      courseId: id,
      page: level === "course" ? route.page : COURSE_HOME,
    });
  /** Opens the page a notification points to, on its course when that is another one. */
  const openTarget = (target: { view: string; courseId: string | null }) => {
    const next = legacyRoute(
      target.view,
      target.courseId && courseTitles.has(target.courseId)
        ? target.courseId
        : null,
    ) ?? { scope: "course", courseId: null, page: "overview" };
    actions.clear();
    navigate(
      next.scope === "workspace"
        ? next
        : { ...next, courseId: next.courseId ?? courseId },
    );
  };
  const found = navigation.find((item) => item.id === view);
  // A page this person is not offered (or a section the course does not declare) opens the
  // level's home instead.
  const waitingForSections = view.startsWith("section:") && declared.loading;
  useEffect(() => {
    // Only once the course (and with it this person's role) has loaded.
    if (!found && !waitingForSections && data)
      navigate(home, { replace: true });
  }, [found, waitingForSections, data]);
  // While the course (and with it the role) loads, a page named in the address keeps its name.
  const pending = !data ? views.find((item) => item.id === view) : undefined;
  const activeView =
    found ??
    (pending && { ...pending, title: t(pending.titleKey), content: false }) ??
    navigation.find((item) => item.id === home.page) ??
    navigation[0]!;
  const sectionId =
    view.startsWith("section:") && found ? view.slice("section:".length) : null;
  // A new page starts with no message from the last one, at the top, its heading focused.
  const clear = useRef(actions.clear);
  clear.current = actions.clear;
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) firstView.current = false;
    else clear.current();
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view, courseId]);
  // Wide windows keep the sidebar; phones and tablets get a top app bar and a navigation drawer.
  const layout = useFrameLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const appBar = useStickyHeight();
  // Phones: the page's own heading names the section at the top of the page, so the app bar
  // shows the section (and the course or workspace) only once that heading has scrolled under
  // the bar. The title is never said twice on one screen. The class is set on the bar directly:
  // scrolling does not re-render the workspace (a re-render would restart loads that depend on
  // fresh props further down).
  const barElement = useRef<HTMLElement | null>(null);
  const barRef = useCallback(
    (element: HTMLElement | null) => {
      barElement.current = element;
      appBar(element);
    },
    [appBar],
  );
  useEffect(() => {
    const target = heading.current;
    const bar = barElement.current;
    if (
      layout === "wide" ||
      !target ||
      !bar ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const barBottom = entry.rootBounds?.top ?? 0;
        bar.classList.toggle(
          "title-in-bar",
          !entry.isIntersecting &&
            entry.boundingClientRect.bottom <= barBottom + 1,
        );
      },
      { rootMargin: "-64px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => {
      observer.disconnect();
      bar.classList.remove("title-in-bar");
    };
  }, [layout, view, actions.loading]);
  // Where focus goes when the drawer closes: back to the menu button, or to the chosen page.
  const afterDrawer = useRef<"menu" | "heading">("menu");
  const drawerShown = drawerOpen && layout !== "wide";
  // A drawer left open when the window widens to the sidebar does not come back on narrowing.
  useEffect(() => {
    if (layout === "wide") setDrawerOpen(false);
  }, [layout]);
  // The sidebar's own scroll keeps the current section in sight: on load, and when a link or a
  // notification opens a section further down the list.
  const sidebarScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = sidebarScroll.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current) return;
    const offset = (element: Element) =>
      element.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop;
    const top = offset(current);
    const bottom = top + current.getBoundingClientRect().height;
    // A small margin, so the item's focus ring is not cut off at the edge either.
    const margin = 12;
    const group = current.closest(".nav-group");
    if (top - margin < list.scrollTop) {
      // Scrolling up: show the item's group heading with it when both fit.
      const groupTop = group ? offset(group) : top;
      list.scrollTop = Math.max(
        0,
        (bottom - groupTop + 2 * margin <= list.clientHeight ? groupTop : top) -
          margin,
      );
    } else if (bottom + margin > list.scrollTop + list.clientHeight) {
      // Scrolling down: stop where a whole item or group heading starts the visible list, so the
      // first one in view is never cut in half under the brand.
      const wanted = bottom + margin - list.clientHeight;
      const starts = [
        ...list.querySelectorAll(".nav-group-label, .nav-links button"),
      ]
        .map(offset)
        .filter((start) => start - margin >= wanted);
      list.scrollTop =
        (starts.length ? Math.min(...starts) : wanted + margin) - margin;
    }
  }, [view, layout]);
  /** Opens a page from the drawer (it closes, and focus goes to the page's heading). */
  const pickView = (id: ViewId) => {
    if (drawerShown) {
      afterDrawer.current = "heading";
      setDrawerOpen(false);
    }
    openView(id);
  };
  /** A link that the app opens itself (a plain click), and the browser in a new tab otherwise. */
  const linkTo = (target: AdminRoute) => ({
    href: routePath(target, adminBase(window.location.pathname)),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      if (actions.pending) return;
      pickView(target.page);
    },
  });
  const navList = (onPick: (id: ViewId) => void) => (
    <nav aria-label={t("adminApp.navigation")} className="nav-links">
      {navGroups
        .filter((group) => group.scope === level)
        .map((group) => {
          const items = navigation.filter((item) => item.group === group.id);
          if (!items.length) return null;
          const labelId = `nav-group-${group.id}`;
          return (
            <div
              key={group.id}
              className="nav-group"
              role="group"
              aria-labelledby={labelId}
            >
              <div className="nav-group-label" id={labelId}>
                {t(group.titleKey)}
              </div>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={activeView.id === item.id ? "active" : ""}
                  aria-current={activeView.id === item.id ? "page" : undefined}
                  onClick={() => onPick(item.id)}
                  disabled={actions.pending}
                >
                  <item.icon size={19} aria-hidden="true" />
                  <span dir={item.content ? "auto" : undefined}>
                    {item.title}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
    </nav>
  );
  const courseTitle = (id: string, title: string) =>
    id === data?.course.id ? data.course.title : title;
  const currentCourse = session.courses.find(
    (course) => course.id === courseId,
  );
  const openCourseTitle = currentCourse
    ? courseTitle(currentCourse.id, currentCourse.title)
    : (data?.course.title ?? "");
  const workspaceName =
    session.workspaces.find((item) => item.id === workspaceId)?.title ??
    currentCourse?.workspaceTitle ??
    data?.course.workspaceTitle ??
    t("adminApp.workspaceFallback");
  // Adding a course installs a package into the open course's workspace.
  const install = installAccess(client, data);
  const [adding, setAdding] = useState(false);
  const startAdding = () => {
    actions.clear();
    // From the phone drawer: the drawer closes (focus returns to the menu button after the dialog).
    afterDrawer.current = "menu";
    setDrawerOpen(false);
    setAdding(true);
  };
  const switcher = (variant: "popover" | "inline") => (
    <CourseSwitcher
      courses={session.courses.map((course) => ({
        id: course.id,
        title: courseTitle(course.id, course.title),
      }))}
      currentId={courseId}
      currentTitle={openCourseTitle}
      disabled={actions.pending}
      variant={variant}
      onSelect={switchCourse}
      onAdd={install.allowed ? startAdding : undefined}
      onAll={() => pickView(WORKSPACE_HOME)}
    />
  );
  /** The top of the sidebar and the drawer: which level this is. A course shows a card with the
   * way back to every course and its name as the course switcher; the workspace, its name. */
  const levelHeader = (variant: "popover" | "inline") =>
    level === "course" ? (
      <div className="level-header level-course">
        <a
          className="level-back"
          {...linkTo({ scope: "workspace", page: WORKSPACE_HOME })}
        >
          <ArrowLeft size={16} className="flip-rtl" aria-hidden="true" />
          <span>{t("adminApp.allCourses")}</span>
        </a>
        {switcher(variant)}
      </div>
    ) : (
      <div
        className="level-header level-workspace"
        title={t("adminApp.level.workspace")}
      >
        <Building2 size={18} aria-hidden="true" />
        <strong dir="auto">{workspaceName}</strong>
      </div>
    );
  /** Where this page is: the workspace, the course (its switcher), the page. */
  const breadcrumb = (
    <nav className="breadcrumb" aria-label={t("adminApp.breadcrumb")}>
      <ol>
        <li>
          <a
            className="breadcrumb-link"
            dir="auto"
            {...linkTo({ scope: "workspace", page: WORKSPACE_HOME })}
          >
            {workspaceName}
          </a>
        </li>
        {level === "course" && (
          <li>
            <ChevronRight
              size={16}
              className="breadcrumb-sep flip-rtl"
              aria-hidden="true"
            />
            {switcher("popover")}
          </li>
        )}
        <li>
          <ChevronRight
            size={16}
            className="breadcrumb-sep flip-rtl"
            aria-hidden="true"
          />
          <span
            className="breadcrumb-page"
            aria-current="page"
            dir={activeView.content ? "auto" : undefined}
          >
            {activeView.title}
          </span>
        </li>
      </ol>
    </nav>
  );
  const bell = client.notifications && workspaceId && (
    <NotificationBell
      port={client.notifications}
      workspaceId={workspaceId}
      courseTitles={courseTitles}
      onOpen={openTarget}
    />
  );
  // Only the demo says what it is: a connected workspace is the normal case and needs no label.
  const modeBadge = client.mode === "demo" && (
    <Badge tone="gold">{t("adminApp.badge.demo")}</Badge>
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
  const sameWorkspace = session.courses.filter(
    (course) =>
      !workspaceId || !course.workspaceId || course.workspaceId === workspaceId,
  );
  return (
    <div
      className={`app-frame level-is-${level} ${layout === "wide" ? "" : `has-app-bar is-${layout}`}`.trim()}
    >
      <a className="skip-link" href="#main-content">
        {t("adminApp.skipLink")}
      </a>
      {layout === "wide" && (
        <aside className="sidebar">
          <Brand />
          {levelHeader("popover")}
          {/* The brand, the level and the signed-in person stay put; the navigation between them
              scrolls on its own, so every section can be reached in a short window. */}
          <div className="sidebar-scroll" ref={sidebarScroll}>
            {navList(openView)}
          </div>
          {actor}
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
          {levelHeader("inline")}
          {navList(pickView)}
          <div className="nav-drawer-foot">
            {(modeBadge || layout === "phone") && (
              <div className="tag-row">
                {modeBadge}
                {layout === "phone" && refresh}
              </div>
            )}
            {actor}
          </div>
        </NavDrawer>
      )}
      <div className="workspace-main">
        {layout === "wide" ? (
          <header className="topbar">
            {breadcrumb}
            <div className="tag-row">
              {bell}
              {modeBadge}
              {refresh}
              {account}
            </div>
          </header>
        ) : (
          <header className="topbar app-bar" ref={barRef}>
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
            {layout === "phone" ? (
              <div className="app-bar-title">
                <strong dir={activeView.content ? "auto" : undefined}>
                  {activeView.title}
                </strong>
                <small dir="auto">
                  {level === "course" ? openCourseTitle : workspaceName}
                </small>
              </div>
            ) : (
              breadcrumb
            )}
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
              {/* What this page belongs to, in full (the switcher and the app bar cut long
                  titles short): the workspace on a workspace page, the course on a course page. */}
              <p className="eyebrow page-course" dir="auto">
                {level === "course" ? openCourseTitle : workspaceName}
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
              {/* Your role here, in words. The workspace data revision is a detail for support,
                  so it is the role's tooltip rather than text on the page. */}
              <span
                className="heading-role"
                title={
                  data
                    ? t("adminApp.revision", { revision: data.revision })
                    : undefined
                }
              >
                <ShieldCheck size={14} aria-hidden="true" />
                {t("adminApp.yourRole", {
                  role: roleLabel(i18n, data?.role ?? session.actor.role),
                })}
              </span>
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
            <div key={`${level}:${activeView.id}`}>
              {activeView.id === "courses" && (
                <CoursesHome
                  client={client}
                  data={data}
                  courses={session.courses}
                  lastCourseId={lastCourseId}
                  titleOf={(course) => courseTitle(course.id, course.title)}
                  addReason={install.allowed ? undefined : t(install.reason)}
                  pending={actions.pending}
                  onAdd={startAdding}
                  onOpen={(id, page) =>
                    navigate({
                      scope: "course",
                      courseId: id,
                      page: page ?? COURSE_HOME,
                    })
                  }
                  onOpenAiServices={() => openView("providers")}
                />
              )}
              {activeView.id === "course" && (
                <CourseView
                  data={data}
                  client={client}
                  actions={actions}
                  onOpenCourse={onOpenCourse}
                />
              )}
              {activeView.id === "learners" && (
                <EnrollmentsView
                  data={data}
                  client={client}
                  actions={actions}
                />
              )}
              {activeView.id === "policy" && (
                <PolicyView data={data} client={client} actions={actions} />
              )}
              {activeView.id === "limits" && (
                <OrganizationLimitsView data={data} client={client} />
              )}
              {activeView.id === "allowances" && client.getAllowances && (
                <AllowancesView data={data} client={client} />
              )}
              {activeView.id === "providers" && (
                <ProvidersView data={data} client={client} actions={actions} />
              )}
              {activeView.id === "reviews" && (
                <ReviewsView data={data} client={client} />
              )}
              {activeView.id === "assessments" && (
                <AssessmentsView data={data} client={client} />
              )}
              {activeView.id === "people" && (
                <PeopleView data={data} client={client} />
              )}
              {activeView.id === "access" && (
                <CourseAccessView data={data} client={client} />
              )}
              {activeView.id === "research" && (
                <ResearchView
                  data={data}
                  client={client}
                  onOpenAiServices={() => openView("providers")}
                />
              )}
              {activeView.id === "media" && (
                <MediaView
                  data={data}
                  client={client}
                  onOpenAiServices={() => openView("providers")}
                />
              )}
              {activeView.id === "runs" && (
                <RunsView data={data} client={client} />
              )}
              {activeView.id === "overview" && (
                <OverviewView
                  data={data}
                  client={client}
                  onOpenView={(id) => openView(id)}
                />
              )}
              {activeView.id === "audit" && (
                <AuditView
                  data={data}
                  client={client}
                  courses={sameWorkspace.map((course) => ({
                    id: course.id,
                    title: courseTitle(course.id, course.title),
                  }))}
                />
              )}
              {activeView.id === "placement" && (
                <PlacementView data={data} client={client} />
              )}
              {activeView.id === "supervision" && (
                <SupervisionView data={data} client={client} />
              )}
              {activeView.id === "mappings" && (
                <ConceptMappingsView
                  client={client}
                  onOpenCourses={() => openView(WORKSPACE_HOME)}
                />
              )}
              {activeView.id === "studies" && (
                <StudyView data={data} client={client} />
              )}
              {activeView.id === "platform" && (
                <PlatformView data={data} client={client} />
              )}
              {activeView.id === "integrations" && (
                <IntegrationsView
                  data={data}
                  client={client}
                  onOpenAiServices={() => openView("providers")}
                />
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
          </footer>
        </main>
        {adding && data?.course.workspaceId && (
          <AddCourseDialog
            client={client}
            workspaceId={data.course.workspaceId}
            currentCourseId={courseId}
            onClose={() => setAdding(false)}
            onOpenCourse={onOpenCourse}
            onCurrentChanged={() => void actions.resync()}
          />
        )}
      </div>
    </div>
  );
}
