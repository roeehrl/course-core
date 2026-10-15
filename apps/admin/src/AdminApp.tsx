import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ClipboardCheck,
  Contact,
  ChevronRight,
  Gauge,
  History,
  Compass,
  Clapperboard,
  Layers3,
  Library,
  ListChecks,
  PanelTop,
  PlugZap,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import type { AdminClient, AdminSession } from "./domain/contracts";
import { useRemote, useWorkspace } from "./hooks/useAdmin";
import { Badge, Button, ErrorState, Loading } from "./components/ui";
import { CourseView } from "./views/CourseView";
import { EnrollmentsView } from "./views/EnrollmentsView";
import { PolicyView } from "./views/PolicyView";
import { ProvidersView } from "./views/ProvidersView";
import { RunsView } from "./views/RunsView";
import { ResearchView } from "./views/ResearchView";
import { PeopleView } from "./views/PeopleView";
import { ReviewsView } from "./views/ReviewsView";
import { MediaView } from "./views/MediaView";
import { OverviewView } from "./views/OverviewView";
import { AuditView } from "./views/AuditView";
import { PlacementView } from "./views/PlacementView";

export interface AdminAppProps {
  client: AdminClient;
}
const views = [
  { id: "overview", title: "Overview", icon: Gauge },
  { id: "course", title: "Course & releases", icon: BookOpen },
  { id: "learners", title: "Enrollments", icon: UsersRound },
  { id: "reviews", title: "Answer reviews", icon: ClipboardCheck },
  { id: "placement", title: "Placement", icon: Compass },
  { id: "people", title: "People & roles", icon: Contact },
  { id: "policy", title: "Policy & extensions", icon: ShieldCheck },
  { id: "research", title: "Research sources", icon: Library },
  { id: "media", title: "Generated media", icon: Clapperboard },
  { id: "providers", title: "Providers", icon: PlugZap },
  { id: "runs", title: "Run inspector", icon: ScanSearch },
  { id: "audit", title: "Audit log", icon: History },
] as const;
type ViewId = (typeof views)[number]["id"];
export function AdminApp({ client }: AdminAppProps) {
  const session = useRemote((signal) => client.getSession(signal), [client]);
  if (session.loading)
    return (
      <main className="startup">
        <Loading label="Opening administration…" />
      </main>
    );
  if (session.error)
    return (
      <main className="startup">
        <h1>Administration</h1>
        <ErrorState error={session.error} onRetry={session.reload} />
      </main>
    );
  if (!session.data?.courses.length)
    return (
      <main className="startup">
        <h1>No course access</h1>
        <p>
          Your account has no courses available. Ask an administrator to check
          your assignments.
        </p>
      </main>
    );
  return <AdminWorkspace client={client} session={session.data} />;
}
function AdminWorkspace({
  client,
  session,
}: {
  client: AdminClient;
  session: AdminSession;
}) {
  const [courseId, setCourseId] = useState(session.courses[0]!.id);
  return (
    <CourseWorkspace
      key={`${session.actor.id}:${courseId}`}
      client={client}
      session={session}
      courseId={courseId}
      onCourseChange={setCourseId}
    />
  );
}
function CourseWorkspace({
  client,
  session,
  courseId,
  onCourseChange,
}: {
  client: AdminClient;
  session: AdminSession;
  courseId: string;
  onCourseChange: (id: string) => void;
}) {
  const actions = useWorkspace(client, courseId);
  const data = actions.workspace;
  const [view, setView] = useState<ViewId>("course");
  const heading = useRef<HTMLHeadingElement>(null);
  const activeView = views.find((item) => item.id === view)!;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view, courseId]);
  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Layers3 size={22} aria-hidden="true" />
          </span>
          <span>
            course<span className="brand-core">core</span>
            <small>ADMINISTRATION</small>
          </span>
        </div>
        <div className="workspace-label">
          <PanelTop size={15} aria-hidden="true" /> Course workspace
        </div>
        <nav aria-label="Workspace navigation" className="nav-links">
          {views.map((item) => (
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
              <span>{item.title}</span>
              {view === item.id && (
                <ChevronRight
                  size={15}
                  className="nav-arrow"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ListChecks size={22} aria-hidden="true" />
          <strong>Intention. Evidence. Review.</strong>
          <p>One workspace for the decisions behind the learning.</p>
          <div className="actor">
            <span className="actor-avatar">{session.actor.name.charAt(0)}</span>
            <div>
              <strong>{session.actor.name}</strong>
              <small>{data?.role ?? session.actor.role}</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="course-picker">
            <label htmlFor="course-select">Course</label>
            <select
              id="course-select"
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
                ? "DEMO WORKSPACE"
                : "CONNECTED WORKSPACE"}
            </Badge>
            <Button
              kind="quiet"
              aria-label="Refresh workspace"
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
                Administration / {data?.course.category ?? "Course workspace"}
              </p>
              <h1 tabIndex={-1} ref={heading}>
                {activeView.title}
              </h1>
            </div>
            <div className="heading-meta">
              <Badge>{data?.role ?? session.actor.role}</Badge>
              {data && <small className="mono">revision {data.revision}</small>}
            </div>
          </div>
          {client.mode === "demo" && (
            <p className="demo-disclosure">
              Public fictional data · in-memory changes · no live provider calls
            </p>
          )}
          {actions.loading ? (
            <Loading />
          ) : actions.loadError ? (
            <ErrorState error={actions.loadError} onRetry={actions.refresh} />
          ) : data ? (
            <div key={view}>
              {view === "course" && (
                <CourseView data={data} client={client} actions={actions} />
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
              {view === "providers" && (
                <ProvidersView data={data} client={client} actions={actions} />
              )}
              {view === "reviews" && (
                <ReviewsView data={data} client={client} />
              )}
              {view === "people" && (
                <PeopleView data={data} client={client} />
              )}
              {view === "research" && (
                <ResearchView data={data} client={client} />
              )}
              {view === "media" && <MediaView data={data} client={client} />}
              {view === "runs" && <RunsView data={data} client={client} />}
              {view === "overview" && <OverviewView data={data} client={client} />}
              {view === "audit" && <AuditView data={data} client={client} />}
              {view === "placement" && <PlacementView data={data} client={client} />}
            </div>
          ) : (
            <Loading />
          )}
          <footer className="footer">
            <span>Course Core / A little more understanding.</span>
            <span>Server authorization governs every action.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
