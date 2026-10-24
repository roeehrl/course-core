import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedHost } from "../src/ConnectedHost.web";
import { compareVersions, library } from "../src/connected/library";
import type { CatalogCourse, Enrollment } from "../src/client/policyClient";

// Synthetic course names and versions only.
const enrollment = (overrides: Partial<Enrollment>): Enrollment => ({
  id: "e1", releaseId: "r-old", title: "Ordering values", version: "0.1.4", status: "active", course_key: "ordering", ...overrides,
});
const course = (overrides: Partial<CatalogCourse>): CatalogCourse => ({
  id: "r-new", title: "Ordering values", version: "0.1.5", status: "published", course_key: "ordering", ...overrides,
});
afterEach(() => vi.unstubAllGlobals());

describe("the home course list", () => {
  it("compares versions by their numbers", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.4", "0.1.5")).toBe(-1);
    expect(compareVersions("2.0.0-beta", "2.0.0-alpha")).toBe(1);
  });

  it("shows a course once: the enrollment to continue, with a newer published version on the same card", () => {
    const result = library([enrollment({})], [course({}), course({ id: "r-other", course_key: "sorting", title: "Sorting" })]);
    expect(result.yours).toEqual([{ key: "ordering", enrollment: enrollment({}), others: [], newer: course({}) }]);
    expect(result.available.map((row) => row.id)).toEqual(["r-other"]);
  });

  it("does not call the same or an older published version newer, and keeps other versions on the card", () => {
    expect(library([enrollment({ releaseId: "r-new", version: "0.1.5" })], [course({})]).yours[0]).not.toHaveProperty("newer");
    expect(library([enrollment({ version: "0.2.0" })], [course({})]).yours[0]).not.toHaveProperty("newer");
    const both = library([enrollment({ id: "e2", releaseId: "r-new", version: "0.1.5" }), enrollment({})], [course({})]);
    expect(both.yours).toHaveLength(1);
    expect(both.yours[0]).toMatchObject({ enrollment: { id: "e2" }, others: [{ id: "e1" }] });
    expect(both.yours[0]).not.toHaveProperty("newer");
    expect(both.available).toEqual([]);
  });

  it("lists a course again as available when its only enrollment was erased", () => {
    const result = library([enrollment({ releaseId: "r-new", status: "erased" })], [course({})]);
    expect(result.yours[0]!.enrollment.status).toBe("erased");
    expect(result.available.map((row) => row.id)).toEqual(["r-new"]);
  });

  it("groups by release when the server names no course", () => {
    const result = library([{ ...enrollment({ releaseId: "r-new" }), course_key: undefined }], [{ ...course({}), course_key: undefined }]);
    expect(result.yours).toHaveLength(1);
    expect(result.available).toEqual([]);
  });
});

function signedIn(enrollments: Enrollment[], courses: CatalogCourse[]) {
  const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/auth/session") return response({ user: { id: "library-user", displayName: "Learner" } });
      if (input === "/api/enrollments") return response(enrollments);
      if (input === "/api/workspaces") return response([{ id: "w1" }]);
      if (input === "/api/workspaces/w1/courses") return response(courses);
      if (input.startsWith("/api/me/locale")) return response({ preference: null, locale: "en", source: "default", workspaceDefault: null, supported: ["en", "he"] });
      throw Error(`Unexpected endpoint ${input}`);
    }),
  );
  render(<ConnectedHost />);
}

describe("the home page", () => {
  it("shows one card per course and says a newer version is available, with a way to start it", async () => {
    signedIn([enrollment({})], [course({})]);
    await screen.findByRole("heading", { name: "Your courses" });
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(within(card).getByText("New version")).toBeVisible();
    expect(within(card).getByText("Version 0.1.4 · active")).toBeVisible();
    expect(within(card).getByText("Version 0.1.5 of this course is available")).toBeVisible();
    expect(within(card).getByText(/You are on version 0\.1\.4 and can keep learning there/)).toBeVisible();
    expect(within(card).getByRole("button", { name: "Continue learning →" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Available in your workspace" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Start version 0.1.5 from the beginning instead" }));
    expect(await screen.findByRole("button", { name: "Start course" })).toBeVisible();
  });

  it("points to the waiting move offer instead of a fresh start when the course team offered one", async () => {
    signedIn([enrollment({ versionOffer: true })], [course({})]);
    const card = (await screen.findAllByRole("article"))[0]!;
    expect(within(card).getByText(/Your course team invited you to move to it/)).toBeVisible();
    expect(within(card).queryByRole("button", { name: /from the beginning/ })).toBeNull();
  });
});
