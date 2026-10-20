import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CourseUpdates } from "../src/components/CourseUpdates";
import type { AdminClient } from "../src/domain/contracts";
import type { UpdatesView } from "../src/domain/courseUpdates";
import type { PackagePreview } from "../src/domain/coursePackages";

// Synthetic identities only.
const base: UpdatesView = {
  revision: 1,
  source: null,
  settings: {
    level: "off",
    intervalHours: 24,
    autoApproveRegistry: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
  },
  status: null,
  newestInstalled: "1.0.0",
  directories: [{ id: "a".repeat(16), name: "packages" }],
  remoteFetch: "github",
  permissions: { configure: true, install: true, publish: true },
};
const withSource: UpdatesView = {
  ...base,
  revision: 2,
  source: {
    kind: "path",
    directoryId: "a".repeat(16),
    directory: "packages",
    subpath: "synthetic/dist",
  },
};
const preview: PackagePreview = {
  sha256: "b".repeat(64),
  compressedBytes: 4096,
  course: {
    id: "synthetic",
    title: "Synthetic course",
    version: "1.1.0",
    digest: "c".repeat(64),
  },
  sdk: {
    packageVersion: "0.5.0",
    coreVersion: "0.5.0",
    supported: { min: "0.5.0", maxExclusive: "0.6.0" },
    status: "supported",
  },
  core: { minimumVersion: "0.1.0", version: "0.1.46", satisfied: true },
  existing: {
    status: "new-version",
    catalogId: "cat-1",
    newestVersion: "1.0.0",
  },
  registry: { present: false },
  hostRequirements: [],
  runtime: { runnable: true },
  members: [],
  problems: [],
  installable: true,
  permissions: {
    install: true,
    approveAndPublish: true,
    approveRegistry: true,
  },
  packageSource: {
    kind: "path",
    directoryId: "a".repeat(16),
    directory: "packages",
    subpath: "synthetic/dist",
    file: "synthetic-1.1.0.course.tgz",
  },
  expiresAt: "2026-10-19T12:00:00Z",
};
function setup(view: UpdatesView = base) {
  const courseUpdates = {
    get: vi.fn(async () => view),
    saveSource: vi.fn(async () => withSource),
    saveSettings: vi.fn(
      async (
        _id: string,
        input: {
          level: UpdatesView["settings"]["level"];
          intervalHours: number;
        },
      ) => ({
        ...withSource,
        revision: 3,
        settings: {
          ...withSource.settings,
          level: input.level,
          intervalHours: input.intervalHours,
          acknowledgedBy: input.level === "publish" ? "Owner example" : null,
        },
      }),
    ),
    check: vi.fn(async () => ({
      outcome: {
        result: "update_available" as const,
        version: "1.1.0",
        sha256: "b".repeat(64),
        newestInstalled: "1.0.0",
        preview,
        diff: {
          from: { version: "1.0.0" },
          to: { version: "1.1.0" },
          identical: false,
          changes: 1,
          kinds: {
            assessments: {
              added: [],
              removed: [],
              changed: ["min-b"],
              unchanged: 3,
            },
          },
        },
      },
      updates: {
        ...withSource,
        status: {
          lastCheckedAt: "2026-10-19T10:00:00Z",
          lastTrigger: "manual",
          lastResult: "update_available",
          lastErrorCode: null,
          availableVersion: "1.1.0",
          consecutiveFailures: 0,
          nextCheckAt: null,
        },
      },
    })),
  };
  const coursePackages = {
    install: vi.fn(),
    inspectFile: vi.fn(),
    inspectUrl: vi.fn(),
    installation: vi.fn(),
    approveRegistry: vi.fn(),
  };
  const client = {
    mode: "connected",
    courseUpdates,
    coursePackages,
  } as unknown as AdminClient;
  const onInstalled = vi.fn();
  render(
    <CourseUpdates
      client={client}
      courseId="cat-1"
      workspaceId="ws-1"
      onInstalled={onInstalled}
    />,
  );
  return { courseUpdates, coursePackages, onInstalled };
}

describe("course updates", () => {
  it("saves a host-folder source by directory id and relative path", async () => {
    const { courseUpdates } = setup();
    await userEvent.click(
      await screen.findByRole("radio", { name: "Host folder" }),
    );
    expect(screen.getByLabelText("Package directory")).toHaveDisplayValue(
      "packages",
    );
    await userEvent.type(
      screen.getByLabelText("Folder or file inside it"),
      "synthetic/dist",
    );
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Save update source" }),
    );
    await waitFor(() =>
      expect(courseUpdates.saveSource).toHaveBeenCalledWith("cat-1", 1, {
        kind: "path",
        directoryId: "a".repeat(16),
        subpath: "synthetic/dist",
      }),
    );
    expect(
      await screen.findByText(
        "Update source saved. Automatic updates are off until you choose a level.",
        { selector: ".notice *" },
      ),
    ).toBeVisible();
  });

  it("checks, shows the version and the change summary, and opens the install flow from the staged preview", async () => {
    const { courseUpdates } = setup(withSource);
    await userEvent.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    await waitFor(() =>
      expect(courseUpdates.check).toHaveBeenCalledWith("cat-1"),
    );
    const update = await screen.findByRole("region", {
      name: "Update to version 1.1.0",
    });
    expect(
      within(update).getByText("Changes from the live release (1.0.0)"),
    ).toBeVisible();
    expect(within(update).getByText(/1 changed/)).toBeVisible();
    await userEvent.click(
      within(update).getByRole("button", { name: "Update to 1.1.0" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Update to 1.1.0",
    });
    expect(
      within(dialog).getByRole("heading", {
        name: "Synthetic course · version 1.1.0",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        "Host folder packages/synthetic/dist/synthetic-1.1.0.course.tgz",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByLabelText("Course package file")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Install draft" }),
    ).toBeEnabled();
  });

  it("requires the explicit acknowledgement before saving automatic publication", async () => {
    const { courseUpdates } = setup(withSource);
    await userEvent.selectOptions(
      await screen.findByLabelText("Automatic level"),
      "publish",
    );
    const save = screen.getByRole("button", { name: "Save automatic updates" });
    expect(save).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: /a changed one waits for an owner or administrator/,
      }),
    ).not.toBeChecked();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I authorize automatic review approval and publication/,
      }),
    );
    await userEvent.clear(screen.getByLabelText("Check every (hours)"));
    await userEvent.type(screen.getByLabelText("Check every (hours)"), "6");
    await userEvent.click(save);
    await waitFor(() =>
      expect(courseUpdates.saveSettings).toHaveBeenCalledWith("cat-1", {
        expectedRevision: 2,
        level: "publish",
        intervalHours: 6,
        acknowledgePublish: true,
        autoApproveRegistry: false,
      }),
    );
    expect(
      await screen.findByText(
        "Automatic publication authorized by Owner example.",
      ),
    ).toBeVisible();
  });

  it("offers only the levels the role may choose", async () => {
    setup({
      ...withSource,
      permissions: { configure: true, install: false, publish: false },
    });
    const select = await screen.findByLabelText("Automatic level");
    expect(
      within(select).getByRole("option", { name: /^Check/ }),
    ).toBeEnabled();
    expect(
      within(select).getByRole("option", { name: /^Install/ }),
    ).toBeDisabled();
    expect(
      within(select).getByRole("option", { name: /^Publish/ }),
    ).toBeDisabled();
  });

  it("shows a recorded failure in words", async () => {
    setup({
      ...withSource,
      status: {
        lastCheckedAt: "2026-10-19T10:00:00Z",
        lastTrigger: "automatic",
        lastResult: "failed",
        lastErrorCode: "COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY",
        availableVersion: null,
        consecutiveFailures: 2,
        nextCheckAt: "2026-10-20T10:00:00Z",
      },
    });
    expect(
      await screen.findByText(
        /automatic · Check failed \(That path leads outside the package directory and was refused\.\)/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/after 2 failed attempts/)).toBeVisible();
  });
});
