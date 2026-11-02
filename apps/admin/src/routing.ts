/**
 * Where each administration page lives. The admin has two levels, like a site and its courses:
 * workspace pages are about every course (`/admin/<page>`), course pages about one course
 * (`/admin/courses/<courseId>/<page>`). The address names the page and its course, so deep
 * links, reloads and the browser's back and forward buttons all land on the same page.
 *
 * Page ids are the view ids the app has always used (notifications and older links still carry
 * them); the address uses a readable slug for each.
 */

/** Pages about the whole workspace. "courses" is its home. */
export const WORKSPACE_PAGES = [
  "courses",
  "people",
  "providers",
  "supervision",
  "limits",
  "mappings",
  "audit",
  "platform",
  "integrations",
] as const;
/** Pages about one course. "course" (Course & releases) is where a course opens. */
export const COURSE_PAGES = [
  "overview",
  "course",
  "assessments",
  "placement",
  "research",
  "media",
  "learners",
  "reviews",
  "allowances",
  "policy",
  "access",
  "studies",
  "runs",
] as const;
export type WorkspacePage = (typeof WORKSPACE_PAGES)[number];
/** A fixed course page, or `section:<id>` for an admin section the course's release declares. */
export type CoursePage = (typeof COURSE_PAGES)[number] | `section:${string}`;
export type PageId = WorkspacePage | CoursePage;
export type AdminRoute =
  | { scope: "workspace"; page: WorkspacePage }
  | { scope: "course"; courseId: string; page: CoursePage };

/** The page a course opens on. */
export const COURSE_HOME: CoursePage = "course";
export const WORKSPACE_HOME: WorkspacePage = "courses";

const SLUGS: Record<WorkspacePage | (typeof COURSE_PAGES)[number], string> = {
  courses: "courses",
  people: "people",
  providers: "ai-services",
  supervision: "ai-supervision",
  limits: "organization-limits",
  mappings: "concept-mappings",
  audit: "audit",
  platform: "platform",
  integrations: "integrations",
  overview: "overview",
  course: "releases",
  assessments: "answer-keys",
  placement: "placement",
  research: "research",
  media: "media",
  learners: "learners",
  reviews: "reviews",
  allowances: "extensions",
  policy: "policy",
  access: "access",
  studies: "studies",
  runs: "runs",
};
const workspaceSet = new Set<string>(WORKSPACE_PAGES);
const courseSet = new Set<string>(COURSE_PAGES);
export const isWorkspacePage = (id: string): id is WorkspacePage =>
  workspaceSet.has(id);
export const isCoursePage = (id: string): id is CoursePage =>
  courseSet.has(id) || /^section:[A-Za-z0-9_.-]{1,100}$/.test(id);

/** A page id from an address segment: its slug, or an older view id with the same meaning. */
function pageFromSegment(segment: string): PageId | null {
  for (const [id, slug] of Object.entries(SLUGS))
    if (slug === segment) return id as PageId;
  if (workspaceSet.has(segment) || courseSet.has(segment))
    return segment as PageId;
  return null;
}

/** The app's base path: the demo runs under /admin/demo, the connected admin under /admin. */
export function adminBase(pathname: string) {
  return /^\/admin\/demo(\/|$)/.test(pathname) ? "/admin/demo" : "/admin";
}

/** The address of a page. */
export function routePath(route: AdminRoute, base: string) {
  if (route.scope === "workspace") return `${base}/${SLUGS[route.page]}`;
  const course = `${base}/courses/${encodeURIComponent(route.courseId)}`;
  if (route.page.startsWith("section:"))
    return `${course}/sections/${encodeURIComponent(route.page.slice("section:".length))}`;
  return `${course}/${SLUGS[route.page as (typeof COURSE_PAGES)[number]]}`;
}

/**
 * What an address asks for. `courseId: null` is a course page without a course (an older
 * address, or a stored view id): it opens on the course the person used last. `null` is the
 * address of the app itself, which opens the last-used course or the Courses home.
 * `canonical: false` means the address should be replaced with the page's own address.
 */
export type ParsedAddress = {
  route:
    AdminRoute | { scope: "course"; courseId: null; page: CoursePage } | null;
  canonical: boolean;
};

/** A route for an older view id (notifications, stored links), on `courseId` when it is a course page. */
export function legacyRoute(
  view: string,
  courseId: string | null,
): ParsedAddress["route"] {
  const page = pageFromSegment(view);
  if (!page) return null;
  if (isWorkspacePage(page)) return { scope: "workspace", page };
  return courseId === null
    ? { scope: "course", courseId: null, page }
    : { scope: "course", courseId, page };
}

export function parseAddress(
  pathname: string,
  search: string,
  hash: string,
  base: string,
): ParsedAddress {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  if (rest && !rest.startsWith("/")) return { route: null, canonical: false };
  const segments = rest
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return "";
      }
    });
  if (!segments.length) {
    // Older addresses named the view in the hash or a query parameter.
    const legacy =
      new URLSearchParams(search).get("view") ?? hash.replace(/^#\/?/, "");
    const route = legacy ? legacyRoute(legacy, null) : null;
    return { route, canonical: !legacy };
  }
  const [first, second, third, fourth, ...more] = segments;
  if (first === "courses" && second !== undefined) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(second))
      return { route: null, canonical: false };
    if (third === undefined)
      return {
        route: { scope: "course", courseId: second, page: COURSE_HOME },
        canonical: false,
      };
    if (third === "sections" && fourth && !more.length) {
      const page = `section:${fourth}`;
      if (isCoursePage(page))
        return {
          route: { scope: "course", courseId: second, page },
          canonical: true,
        };
      return { route: null, canonical: false };
    }
    const page = pageFromSegment(third);
    if (!page || fourth !== undefined) return { route: null, canonical: false };
    if (isWorkspacePage(page))
      return { route: { scope: "workspace", page }, canonical: false };
    return {
      route: { scope: "course", courseId: second, page },
      canonical: third === SLUGS[page as (typeof COURSE_PAGES)[number]],
    };
  }
  if (second !== undefined) return { route: null, canonical: false };
  const page = pageFromSegment(first!);
  if (!page) return { route: null, canonical: false };
  if (isWorkspacePage(page))
    return {
      route: { scope: "workspace", page },
      canonical: first === SLUGS[page],
    };
  return { route: { scope: "course", courseId: null, page }, canonical: false };
}

/** The last course each person opened, kept in this browser. Storage may be unavailable. */
const lastCourseKey = (actorId: string) =>
  `course-core.admin.last-course:${actorId}`;
export function rememberCourse(actorId: string, courseId: string) {
  try {
    window.localStorage.setItem(lastCourseKey(actorId), courseId);
  } catch {
    // Private windows and blocked storage: the app still opens, on the Courses home.
  }
}
export function lastCourse(actorId: string): string | null {
  try {
    return window.localStorage.getItem(lastCourseKey(actorId));
  } catch {
    return null;
  }
}
