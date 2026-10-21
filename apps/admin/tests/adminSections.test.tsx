import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { AdminSectionView } from "../src/views/AdminSectionView";
import { AdminApp } from "../src/AdminApp";
import {
  AdminSectionError,
  adminSectionErrorMessage,
  settingProblem,
  type AdminSectionList,
  type AdminSectionView as Section,
  type AdminSectionsPort,
} from "../src/domain/adminSections";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import { demo } from "./helpers";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const list: AdminSectionList = {
  release: { id: "r1", version: "2.0.0" },
  sections: [{ id: "glaze-lab", version: "1.0.0", title: "Glaze lab" }],
  chapters: [{ id: "ch1", title: "Firing" }],
};
function section(canEdit: boolean, overrides: Partial<Section> = {}): Section {
  const base = {
    scope: "course" as const,
    mutationPermission: "course.settings.write",
    description: null,
    discardedSavedValue: false,
    canEdit,
  };
  return {
    id: "glaze-lab",
    version: "1.0.0",
    title: "Glaze lab",
    description: "Kiln practice settings.",
    learnerDataAccess: "scoped_with_consent",
    learnerDataShared: false,
    renderer: {
      kind: "core_schema_form",
      declaredRendererRef: "glaze-panel",
      declaredRendererLoaded: false,
    },
    scopes: ["course", "chapter"],
    scope: "course",
    scopeRef: "",
    revision: 2,
    savedForVersion: "1.0.0",
    updatedAt: "2026-10-01T10:00:00.000Z",
    settings: [
      {
        ...base,
        id: "cone",
        label: "Kiln cone",
        type: "integer",
        default: 6,
        minimum: 1,
        maximum: 10,
        value: 6,
        source: "saved",
      },
      {
        ...base,
        id: "finish",
        label: "Finish",
        type: "enum",
        default: "matte",
        options: ["matte", "gloss"],
        value: "matte",
        source: "default",
      },
      {
        ...base,
        id: "note",
        label: "Studio note",
        type: "string",
        default: "",
        maxLength: 5,
        value: "",
        source: "default",
        discardedSavedValue: true,
      },
    ],
    ...overrides,
  };
}
const workspace = (
  permissions: string[] = ["course.read", "course.write", "enrollment.read"],
) =>
  ({
    course: { id: "c1" },
    permissions,
    enrollments: [
      { id: "e1", status: "active", profile: { displayName: "Avery Learner" } },
    ],
  }) as unknown as CourseWorkspace;

describe("course-declared admin sections", () => {
  it("renders the schema as a form, explains what Core does not load or share, and saves only changed values", async () => {
    const port: AdminSectionsPort = {
      list: vi.fn(),
      read: vi.fn(async () => ({
        release: { id: "r1", version: "2.0.0" },
        section: section(true),
      })),
      save: vi.fn(async () => ({ section: section(true, { revision: 3 }) })),
    };
    render(
      <AdminSectionView
        port={port}
        data={workspace()}
        sectionId="glaze-lab"
        list={list}
      />,
    );
    expect(await screen.findByText("Kiln practice settings.")).toBeVisible();
    expect(
      screen.getByText("Custom renderer glaze-panel not loaded"),
    ).toBeVisible();
    expect(
      screen.getByText(
        /There is no learner sharing control yet, so Core shares none/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/saved value no longer fits this release/),
    ).toBeVisible();
    const save = screen.getByRole("button", { name: "Save Glaze lab" });
    expect(save).toBeDisabled();
    const cone = screen.getByLabelText("Kiln cone");
    await userEvent.clear(cone);
    await userEvent.type(cone, "11");
    expect(screen.getByText(/Between 1 and 10\./)).toBeVisible();
    expect(save).toBeDisabled();
    await userEvent.clear(cone);
    await userEvent.type(cone, "8.5");
    expect(screen.getByText(/Enter a whole number\./)).toBeVisible();
    await userEvent.clear(cone);
    await userEvent.type(cone, "8");
    await userEvent.selectOptions(screen.getByLabelText("Finish"), "gloss");
    await userEvent.click(save);
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith("c1", "glaze-lab", {
        scope: "course",
        scopeRef: "",
        expectedRevision: 2,
        values: { cone: 8, finish: "gloss" },
      }),
    );
    expect(
      await screen.findByText("Glaze lab saved (revision 3)."),
    ).toBeVisible();
  });

  it("is read-only when the server says the role cannot edit, and shows refusals plainly", async () => {
    const port: AdminSectionsPort = {
      list: vi.fn(),
      read: vi.fn(async () => ({
        release: { id: "r1", version: "2.0.0" },
        section: section(false),
      })),
      save: vi.fn(),
    };
    render(
      <AdminSectionView
        port={port}
        data={workspace(["course.read"])}
        sectionId="glaze-lab"
        list={list}
      />,
    );
    expect(
      await screen.findByText(
        "Read only: your role cannot change these settings.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Kiln cone")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save Glaze lab" })).toBeNull();
    expect(
      adminSectionErrorMessage(new AdminSectionError("STALE_REVISION")),
    ).toMatch(/changed these settings/);
    expect(adminSectionErrorMessage(new Error("x"))).toMatch(/Nothing changed/);
  });

  it("asks for a chapter before loading chapter-level settings", async () => {
    const read = vi.fn(
      async (_c: string, _s: string, target: { scope: string }) => ({
        release: { id: "r1", version: "2.0.0" },
        section:
          target.scope === "chapter"
            ? section(true, {
                scope: "chapter",
                scopeRef: "ch1",
                revision: 0,
                settings: [
                  {
                    id: "slow",
                    label: "Slow cooling",
                    scope: "chapter",
                    mutationPermission: "course.settings.write",
                    description: null,
                    discardedSavedValue: false,
                    canEdit: true,
                    type: "boolean",
                    default: false,
                    value: false,
                    source: "default",
                  },
                ],
              })
            : section(true),
      }),
    );
    const port: AdminSectionsPort = {
      list: vi.fn(),
      read,
      save: vi.fn(async () => ({ section: section(true) })),
    };
    render(
      <AdminSectionView
        port={port}
        data={workspace()}
        sectionId="glaze-lab"
        list={list}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "One chapter" }),
    );
    expect(screen.getByText(/Pick a chapter/)).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText("Chapter"), "ch1");
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Slow cooling" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save Glaze lab" }),
    );
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith("c1", "glaze-lab", {
        scope: "chapter",
        scopeRef: "ch1",
        expectedRevision: 0,
        values: { slow: true },
      }),
    );
  });

  it("adds one navigation entry per section the server lists", async () => {
    const base = demo();
    const port: AdminSectionsPort = {
      list: vi.fn(async () => list),
      read: vi.fn(async () => ({
        release: { id: "r1", version: "2.0.0" },
        section: section(true),
      })),
      save: vi.fn(),
    };
    const client = Object.assign(
      Object.create(Object.getPrototypeOf(base)),
      base,
      { adminSections: port },
    ) as AdminClient;
    render(<AdminApp client={client} />);
    const nav = await screen.findByRole("navigation", {
      name: "Workspace navigation",
    });
    await userEvent.click(
      await within(nav).findByRole("button", { name: "Glaze lab" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Glaze lab", level: 1 }),
    ).toBeVisible();
    expect(port.list).toHaveBeenCalled();
  });

  it("calls the section routes", async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return calls.length === 1
          ? new Response(JSON.stringify(list), { status: 200 })
          : new Response(JSON.stringify({ error: "ADMIN_SETTING_INVALID" }), {
              status: 400,
            });
      },
    });
    expect(await client.adminSections!.list("c1")).toEqual(list);
    const refused = await client
      .adminSections!.save("c1", "glaze-lab", {
        scope: "course",
        scopeRef: "",
        expectedRevision: 2,
        values: { cone: 99 },
      })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(AdminSectionError);
    expect(calls[1]).toEqual({
      url: "/api/admin/courses/c1/admin-sections/glaze-lab/values",
      method: "PUT",
      body: {
        scope: "course",
        scopeRef: "",
        expectedRevision: 2,
        values: { cone: 99 },
      },
    });
  });
});

describe("course-declared admin sections in Hebrew", () => {
  const he = createAdminTranslator("he");
  it("labels the form in Hebrew and keeps course text as written", async () => {
    const port: AdminSectionsPort = {
      list: vi.fn(),
      read: vi.fn(async () => ({
        release: { id: "r1", version: "2.0.0" },
        section: section(false),
      })),
      save: vi.fn(),
    };
    render(
      <I18nProvider value={he}>
        <AdminSectionView
          port={port}
          data={workspace(["course.read"])}
          sectionId="glaze-lab"
          list={list}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByText(
        "צפייה בלבד: לתפקיד שלך אין הרשאה לשנות את ההגדרות האלה.",
      ),
    ).toBeVisible();
    // Course text keeps its own direction.
    expect(screen.getByText("Kiln practice settings.")).toHaveAttribute(
      "dir",
      "auto",
    );
    expect(
      screen.getByText((_, el) =>
        el?.tagName === "SPAN" && el.classList.contains("badge")
          ? stripBidiControls(el.textContent ?? "") ===
            "המציג המותאם glaze-panel לא נטען"
          : false,
      ),
    ).toBeVisible();
  });

  it("explains invalid values and refusals in Hebrew", () => {
    const cone = section(true).settings.find((s) => s.id === "cone")!;
    expect(settingProblem(cone, "11", he.t)).toBe("בין 1 ל-10.");
    expect(settingProblem(cone, "8.5", he.t)).toBe("יש להזין מספר שלם.");
    expect(
      adminSectionErrorMessage(new AdminSectionError("STALE_REVISION"), he.t),
    ).toBe("ההגדרות השתנו מאז שנפתחו. יש לטעון מחדש ולנסות שוב.");
    expect(adminSectionErrorMessage(new Error("x"), he.t)).toBe(
      "הגדרות הקורס לא זמינות. שום דבר לא השתנה.",
    );
  });
});
