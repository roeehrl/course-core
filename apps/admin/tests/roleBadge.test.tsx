import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminApp, knownRole } from "../src/AdminApp";
import type {
  AdminClient,
  AdminSession,
  CourseWorkspace,
} from "../src/domain/contracts";
import { demoSession, demoWorkspace } from "../src/data/fixtures";
import { demo, openAddress } from "./helpers";

/**
 * The page heading's "Your role" badge and the sidebar's role line never show a role this person
 * does not have. The connected server's session names everyone a generic "member"; the real role
 * comes with the course (or the session's entry for it), so until then the badge is an empty
 * placeholder of the same shape, never "Member".
 */

/** The session as the connected server sends it: a generic actor role. */
function liveSession(courseRole?: string): AdminSession {
  const session = demoSession("administrator");
  return {
    ...session,
    actor: { ...session.actor, role: "member" },
    courses: session.courses.map((course) =>
      courseRole ? { ...course, role: courseRole } : course,
    ),
  };
}

/** A client whose course read waits until `release` is called. */
function slowCourseClient(session: AdminSession) {
  const base = demo();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client: AdminClient = {
    ...base,
    getSession: async () => session,
    getCourse: async (courseId: string, signal?: AbortSignal) => {
      await gate;
      const course = await base.getCourse(courseId, signal);
      return { ...course, role: "owner" } satisfies CourseWorkspace;
    },
  };
  return { client, release: () => act(async () => release()) };
}

const badge = () => document.querySelector(".page-heading .heading-role");
const sidebar = () => document.querySelector(".sidebar > .actor small");

describe("knownRole", () => {
  const session = liveSession();
  const workspace = demoWorkspace(session.courses[0]!, "administrator");
  it("is not known before the course loads when the session does not name it", () => {
    expect(knownRole(session, "sorting", undefined)).toBeNull();
  });
  it("takes the session's entry for the course before the course loads", () => {
    expect(knownRole(liveSession("owner"), "sorting", undefined)).toBe("owner");
    expect(knownRole(liveSession("owner"), "elsewhere", undefined)).toBeNull();
  });
  it("takes the course's role once it has loaded", () => {
    expect(knownRole(session, "sorting", { ...workspace, role: "owner" })).toBe(
      "owner",
    );
    expect(
      knownRole(liveSession("author"), "sorting", {
        ...workspace,
        role: "admin",
      }),
    ).toBe("admin");
  });
  it("falls back to the actor's role only after the course has loaded without one", () => {
    expect(knownRole(session, "sorting", {})).toBe("member");
  });
});

describe("role badge while the workspace loads", () => {
  it("shows an empty placeholder, never a guessed role, and then the real role", async () => {
    openAddress("/admin/");
    const { client, release } = slowCourseClient(liveSession());
    render(<AdminApp client={client} />);
    expect(await screen.findByText("Loading workspace…")).toBeInTheDocument();
    expect(screen.queryByText(/Your role/)).toBeNull();
    expect(screen.queryByText("Member")).toBeNull();
    expect(screen.queryByText(/Member/)).toBeNull();
    expect(badge()).toHaveClass("is-pending");
    expect(badge()).toHaveAttribute("aria-hidden", "true");
    expect(sidebar()).toHaveAttribute("aria-hidden", "true");
    expect(sidebar()?.textContent?.trim()).toBe("");
    // Owner-only pages are not offered while the role is unknown.
    expect(
      within(
        screen.getByRole("navigation", { name: "Workspace navigation" }),
      ).queryByText("Platform"),
    ).toBeNull();
    await release();
    expect(await screen.findByText("Your role: Owner")).toBeInTheDocument();
    expect(badge()).not.toHaveClass("is-pending");
    expect(sidebar()).toHaveTextContent("Owner");
    expect(screen.queryByText(/Member/)).toBeNull();
  });

  it("names the role from the session's entry for the course before the course loads", async () => {
    openAddress("/admin/");
    const { client, release } = slowCourseClient(liveSession("owner"));
    render(<AdminApp client={client} />);
    expect(await screen.findByText("Loading workspace…")).toBeInTheDocument();
    expect(screen.getByText("Your role: Owner")).toBeInTheDocument();
    expect(screen.queryByText(/Member/)).toBeNull();
    // Owner pages are offered at once, not hidden and then shown.
    const nav = screen.getByRole("navigation", {
      name: "Workspace navigation",
    });
    expect(within(nav).getByText("Platform")).toBeInTheDocument();
    await release();
    expect(await screen.findByText("Your role: Owner")).toBeInTheDocument();
    expect(within(nav).getByText("Platform")).toBeInTheDocument();
  });
});
