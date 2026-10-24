import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { InstallCourse, SLOW_MS } from "../src/components/InstallCourse";
import { createAdminTranslator, I18nProvider } from "../src/i18n";
import type { AdminClient } from "../src/domain/contracts";
import {
  CoursePackageError,
  type Installation,
  packageMessage,
  type PackagePreview,
} from "../src/domain/coursePackages";

// Synthetic course identities only.
const digest = "a".repeat(64);
function preview(overrides: Partial<PackagePreview> = {}): PackagePreview {
  return {
    sha256: "b".repeat(64),
    compressedBytes: 2048,
    course: {
      id: "synthetic",
      title: "Synthetic course",
      version: "1.2.0",
      digest,
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
      newestVersion: "1.1.0",
    },
    registry: {
      present: true,
      digest: "c".repeat(64),
      profileCount: 2,
      approvable: true,
    },
    hostRequirements: [
      {
        name: "fixture.py",
        sha256: "d".repeat(64),
        bytes: 10,
        status: "identical",
      },
      {
        name: "verifier.json",
        sha256: "e".repeat(64),
        bytes: 10,
        status: "missing",
      },
    ],
    runtime: { runnable: true },
    members: [{ name: "course.json", role: "course-manifest", bytes: 100 }],
    problems: [
      {
        code: "HOST_REQUIREMENT_MISSING",
        severity: "warning",
        params: { name: "verifier.json", sha256: "0123456789ab" },
      },
    ],
    installable: true,
    permissions: {
      install: true,
      approveAndPublish: true,
      approveRegistry: true,
    },
    packageSource: { kind: "upload" },
    expiresAt: "2026-10-19T12:00:00Z",
    ...overrides,
  };
}
function installation(overrides: Partial<Installation> = {}): Installation {
  return {
    releaseId: "rel-1",
    catalogId: "cat-2",
    catalogRevision: "4",
    workspaceId: "ws-1",
    course: {
      id: "synthetic",
      title: "Synthetic course",
      version: "1.2.0",
      digest,
    },
    state: "pending_review",
    availableForNewLearners: false,
    package: {
      sha256: "b".repeat(64),
      source: { kind: "upload" },
      sdkVersion: "0.5.0",
      minimumCoreVersion: "0.1.0",
      installedAt: "2026-10-19T12:00:00Z",
    },
    registry: {
      present: true,
      digest: "c".repeat(64),
      profileCount: 2,
      registryRevision: 0,
      approved: false,
    },
    permissions: { approve: true, publish: true, approveRegistry: true },
    ...overrides,
  };
}
function setup(
  port: Partial<NonNullable<AdminClient["coursePackages"]>> = {},
  locale: "en" | "he" = "en",
) {
  const coursePackages = {
    inspectFile: vi.fn(async () => preview()),
    inspectUrl: vi.fn(async () =>
      preview({
        packageSource: {
          kind: "github",
          owner: "example",
          repo: "course",
          tag: "v1.2.0",
          asset: "course.course.tgz",
          checksumVerified: true,
        },
      }),
    ),
    install: vi.fn(async () => ({
      alreadyInstalled: false,
      releaseId: "rel-1",
      installation: installation(),
    })),
    installation: vi.fn(async () => installation()),
    approveRegistry: vi.fn(async () =>
      installation({
        registry: {
          present: true,
          digest: "c".repeat(64),
          profileCount: 2,
          registryRevision: 1,
          approved: true,
        },
      }),
    ),
    ...port,
  };
  const transitionRelease = vi.fn(async () => ({}));
  const client = {
    mode: "connected",
    coursePackages,
    transitionRelease,
  } as unknown as AdminClient;
  const onFinished = vi.fn();
  render(
    <I18nProvider value={createAdminTranslator(locale)}>
      <InstallCourse
        client={client}
        workspaceId="ws-1"
        onFinished={onFinished}
      />
    </I18nProvider>,
  );
  return { coursePackages, transitionRelease, onFinished };
}
const packageFile = () =>
  new File([new Uint8Array([0x1f, 0x8b, 1, 2])], "synthetic-1.2.0.course.tgz", {
    type: "application/gzip",
  });

describe("installing a course package", () => {
  it("inspects an uploaded file, shows the preview and installs a draft in review", async () => {
    const { coursePackages, onFinished } = setup();
    const input = screen.getByLabelText("Course package file");
    expect(input).toHaveAttribute(
      "accept",
      ".tgz,.course.tgz,application/gzip",
    );
    expect(input).toHaveAccessibleDescription(
      /\.course\.tgz file, at most 64 MiB/,
    );
    await userEvent.upload(input, packageFile());
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    const heading = await screen.findByRole("heading", {
      name: "Synthetic course · version 1.2.0",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(coursePackages.inspectFile).toHaveBeenCalledWith(
      "ws-1",
      expect.any(File),
    );
    expect(
      screen.getByText(
        /Package checked: Synthetic course 1\.2\.0\. No blocking problems\./,
      ),
    ).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Present, identical")).toBeVisible();
    expect(screen.getByText("Missing on this host")).toBeVisible();
    expect(screen.getByText(/1 warning/)).toBeVisible();
    expect(screen.getByText(/2 profiles · digest cccccccccccc…/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Install draft" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Release 1.2.0 installed" }),
    ).toHaveFocus();
    expect(coursePackages.install).toHaveBeenCalledWith("b".repeat(64), {
      workspaceId: "ws-1",
      idempotencyKey: expect.stringMatching(
        /^package-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    });
    expect(
      screen.getByText(/Version 1.2.0 installed. State: pending review./),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Done — open this course" }),
    );
    expect(onFinished).toHaveBeenCalledWith("cat-2");
  });

  it("lists the files a course brings and installs only after they are approved", async () => {
    const script = "sha256-" + "1".repeat(64),
      cases = "sha256-" + "2".repeat(64);
    const { coursePackages } = setup({
      inspectFile: vi.fn(async () =>
        preview({
          hostRequirements: [
            {
              name: "lab.code-fixtures.json",
              sha256: "2".repeat(64),
              bytes: 300,
              status: "course_supplied",
            },
          ],
          problems: [],
          courseSupplied: {
            files: [
              {
                extensionId: "lab-activity",
                version: "1.0.0",
                integrity: script,
                kind: "sandboxed_web",
                member: "lab.js",
                bytes: 200,
                status: "approvable",
              },
              {
                extensionId: "lab-code",
                version: "1.0.0",
                integrity: cases,
                kind: "code_fixtures",
                member: "lab.code-fixtures.json",
                bytes: 300,
                status: "approvable",
              },
              {
                extensionId: "lab-extra",
                version: "1.0.0",
                integrity: "sha256-" + "3".repeat(64),
                kind: "code_fixtures",
                member: "extra.json",
                bytes: 30,
                status: "unavailable",
                code: "NO_SANDBOX",
              },
            ],
            approvalRequired: [script, cases],
          },
        }),
      ),
    });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Files the course brings" }),
    ).toBeVisible();
    expect(screen.getByText("Supplied by the course")).toBeVisible();
    expect(screen.getByText("Interactive activity")).toBeVisible();
    expect(
      screen.getAllByText("Hidden test cases for code tasks"),
    ).toHaveLength(2);
    expect(screen.getAllByText("Needs your approval")).toHaveLength(2);
    expect(screen.getByText(/has no code grader turned on/)).toBeVisible();
    const install = screen.getByRole("button", { name: "Install draft" });
    expect(install).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I approve the 2 files this course brings/,
      }),
    );
    expect(install).toBeEnabled();
    await userEvent.click(install);
    await waitFor(() =>
      expect(coursePackages.install).toHaveBeenCalledWith(
        "b".repeat(64),
        expect.objectContaining({
          approveCourseSupplied: { integrities: [script, cases] },
        }),
      ),
    );
  });

  it("blocks installation while there are blocking problems and lists them first", async () => {
    setup({
      inspectFile: vi.fn(async () =>
        preview({
          installable: false,
          problems: [
            {
              code: "CORE_VERSION_TOO_OLD",
              severity: "blocking",
              params: { required: "9.0.0", current: "0.1.52" },
            },
          ],
        }),
      ),
    });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "1 blocking problemNeeds Core 9.0.0; this Core is 0.1.52. Update Core first. CORE_VERSION_TOO_OLD",
    );
    expect(
      screen.getByRole("button", { name: "Install draft" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Resolve the blocking problems before installing."),
    ).toBeVisible();
  });

  it("refuses a course built with SDK 0.4 and says to rebuild it with SDK 0.5, in English and Hebrew", async () => {
    const old = () =>
      preview({
        installable: false,
        sdk: {
          packageVersion: "0.4.0",
          coreVersion: "0.5.0",
          supported: { min: "0.5.0", maxExclusive: "0.6.0" },
          status: "below_minimum",
        },
        problems: [
          {
            code: "SDK_BELOW_MINIMUM",
            severity: "blocking",
            params: { sdkVersion: "0.4.0", minimum: "0.5.0" },
          },
        ],
      });
    setup({ inspectFile: vi.fn(async () => old()) });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Built with SDK 0.4.0; this Core supports courses from SDK 0.5.0 on. Rebuild the course with SDK 0.5.0 or later.",
    );
    expect(
      screen.getByRole("button", { name: "Install draft" }),
    ).toBeDisabled();
    const he = createAdminTranslator("he");
    expect(
      stripBidiControls(
        he.t("installCourse.problem.SDK_BELOW_MINIMUM", {
          sdkVersion: "0.4.0",
          minimum: "0.5.0",
        }),
      ),
    ).toBe(
      "נבנה עם SDK 0.4.0; ה-Core הזה תומך בקורסים מ-SDK 0.5.0 ואילך. יש לבנות את הקורס מחדש עם SDK 0.5.0 או חדש יותר.",
    );
    expect(packageMessage("SDK_BELOW_MINIMUM", he.t)).toContain("SDK 0.5");
    expect(packageMessage("PUBLISH_RECOGNITION_ONLY_GATE")).toBe(
      "A checkpoint in this version offers only multiple-choice questions, so it cannot be published. Add a question where the learner writes or calculates the answer.",
    );
  });

  it("requires the exact version before installing, approving and publishing at once", async () => {
    const { coursePackages } = setup();
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: "Also approve the review and publish this version now",
      }),
    );
    const submit = screen.getByRole("button", {
      name: "Install, approve and publish",
    });
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Type 1.2.0 to confirm publication"),
      "1.2",
    );
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Type 1.2.0 to confirm publication"),
      ".0",
    );
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /Also approve the packaged recovery registry \(digest cccccccccccc…\)/,
      }),
    );
    await userEvent.click(submit);
    await waitFor(() =>
      expect(coursePackages.install).toHaveBeenCalledWith(
        "b".repeat(64),
        expect.objectContaining({
          approveAndPublish: { confirmVersion: "1.2.0" },
          approveRegistry: { configurationDigest: "c".repeat(64) },
        }),
      ),
    );
  });

  it("asks for an explicit choice before installing a version older than the newest installed", async () => {
    const { coursePackages } = setup({
      inspectFile: vi.fn(async () =>
        preview({
          course: {
            id: "synthetic",
            title: "Synthetic course",
            version: "1.0.5",
            digest,
          },
          existing: {
            status: "new-version",
            catalogId: "cat-1",
            newestVersion: "1.2.0",
          },
          problems: [
            {
              code: "OLDER_THAN_INSTALLED",
              severity: "warning",
              params: { newest: "1.2.0" },
            },
          ],
        }),
      ),
    });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(await screen.findByText("This is an older version")).toBeVisible();
    expect(
      screen.getByText(
        /Version 1\.2\.0 of this course is already installed here, and this package is version 1\.0\.5/,
      ),
    ).toBeVisible();
    const submit = screen.getByRole("button", { name: "Install draft" });
    expect(submit).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I want to install the older version 1.0.5",
      }),
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() =>
      expect(coursePackages.install).toHaveBeenCalledWith(
        "b".repeat(64),
        expect.objectContaining({ confirmOlderVersion: true }),
      ),
    );
  });

  it("does not send an older-version confirmation for a newer version", async () => {
    const { coursePackages } = setup();
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(screen.queryByText("This is an older version")).toBeNull();
    await userEvent.click(
      await screen.findByRole("button", { name: "Install draft" }),
    );
    await waitFor(() => expect(coursePackages.install).toHaveBeenCalled());
    expect(coursePackages.install).toHaveBeenCalledWith(
      "b".repeat(64),
      expect.not.objectContaining({ confirmOlderVersion: true }),
    );
  });

  it("explains an older-version refusal in English and Hebrew", () => {
    expect(packageMessage("OLDER_VERSION_CONFIRMATION_REQUIRED")).toMatch(
      /newer version of this course is already installed/,
    );
    const he = createAdminTranslator("he");
    expect(packageMessage("OLDER_VERSION_CONFIRMATION_REQUIRED", he.t)).toMatch(
      /גרסה חדשה יותר/,
    );
    expect(
      packageMessage("PUBLISH_VERSION_OLDER_THAN_PUBLISHED", he.t),
    ).toMatch(/פורסמה גרסה חדשה יותר/);
  });

  it("does not offer approve-and-publish without both permissions", async () => {
    setup({
      inspectFile: vi.fn(async () =>
        preview({
          permissions: {
            install: true,
            approveAndPublish: false,
            approveRegistry: false,
          },
        }),
      ),
    });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    await screen.findByRole("button", { name: "Install draft" });
    expect(screen.queryByRole("checkbox", { name: /publish/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /registry/ })).toBeNull();
  });

  it("asks for a choice when a GitHub release has several packages", async () => {
    const inspectUrl = vi
      .fn()
      .mockRejectedValueOnce(
        new CoursePackageError("COURSE_PACKAGE_ASSET_CHOICE_REQUIRED", {
          assets: ["a.course.tgz", "b.course.tgz"],
        }),
      )
      .mockResolvedValueOnce(preview());
    setup({ inspectUrl });
    await userEvent.click(screen.getByRole("radio", { name: "From GitHub" }));
    const url = screen.getByLabelText("GitHub link");
    expect(url).toHaveAccessibleDescription(
      /https:\/\/github\.com\/owner\/course\/releases\/tag\/v1\.2\.0/,
    );
    await userEvent.type(url, "https://github.com/example/course");
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The release has several course packages. Choose one.",
    );
    const inspect = screen.getByRole("button", { name: "Inspect package" });
    expect(inspect).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText("Package in this release"),
      "b.course.tgz",
    );
    await userEvent.click(inspect);
    await screen.findByRole("heading", {
      name: "Synthetic course · version 1.2.0",
    });
    expect(inspectUrl).toHaveBeenLastCalledWith(
      "ws-1",
      "https://github.com/example/course",
      "b.course.tgz",
    );
  });

  it("shows a clear refusal for a private or missing repository", async () => {
    setup({
      inspectUrl: vi.fn(async () => {
        throw new CoursePackageError("GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING");
      }),
    });
    await userEvent.click(screen.getByRole("radio", { name: "From GitHub" }));
    await userEvent.type(
      screen.getByLabelText("GitHub link"),
      "https://github.com/example/private",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That GitHub repository does not exist or is not public.",
    );
  });

  it("runs approve, publish and registry approval with explicit confirmations", async () => {
    const states = [
      installation({ state: "approved", catalogRevision: "5" }),
      installation({
        state: "published",
        availableForNewLearners: true,
        catalogRevision: "6",
      }),
    ];
    const { coursePackages, transitionRelease } = setup({
      installation: vi.fn(
        async () => states.shift() ?? installation({ state: "published" }),
      ),
    });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Install draft" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve review" }),
    );
    await waitFor(() =>
      expect(transitionRelease).toHaveBeenCalledWith(
        "cat-2",
        "rel-1",
        "approve",
        expect.objectContaining({ expectedRevision: "4" }),
      ),
    );
    const confirm = await screen.findByRole("button", {
      name: "Confirm publication",
    });
    expect(confirm).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I confirm publication of version 1.2.0.",
      }),
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(transitionRelease).toHaveBeenCalledWith(
        "cat-2",
        "rel-1",
        "publish",
        expect.objectContaining({ expectedRevision: "5" }),
      ),
    );
    expect(await screen.findByText("Available to new learners")).toBeVisible();
    const approveRegistry = screen.getByRole("button", {
      name: "Approve recovery registry",
    });
    expect(approveRegistry).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: /I approve the packaged recovery registry \(2 profiles, digest cccccccccccc…\) for version 1\.2\.0/,
      }),
    );
    await userEvent.click(approveRegistry);
    await waitFor(() =>
      expect(coursePackages.approveRegistry).toHaveBeenCalledWith("rel-1", {
        configurationDigest: "c".repeat(64),
        expectedRegistryRevision: 0,
      }),
    );
  });

  it("renders the preview, refusals and install status in Hebrew", async () => {
    const he = createAdminTranslator("he");
    const { coursePackages } = setup(
      {
        inspectFile: vi.fn(async () =>
          preview({
            installable: false,
            problems: [
              {
                code: "CORE_VERSION_TOO_OLD",
                severity: "blocking",
                params: { required: "9.0.0", current: "0.1.52" },
              },
              { code: "W1", severity: "warning" },
              { code: "W2", severity: "warning" },
            ],
          }),
        ),
      },
      "he",
    );
    await userEvent.upload(
      screen.getByLabelText("קובץ חבילת הקורס"),
      packageFile(),
    );
    await userEvent.click(screen.getByRole("button", { name: "בדיקת החבילה" }));
    const heading = await screen.findByRole("heading", { level: 3 });
    expect(stripBidiControls(heading.textContent ?? "")).toBe(
      "Synthetic course · גרסה 1.2.0",
    );
    // The course title is isolated; the version reads left to right.
    expect(heading.querySelector("bdi[dir=auto]")).toHaveTextContent(
      "Synthetic course",
    );
    expect(heading.querySelector("bdi[dir=ltr]")).toHaveTextContent("1.2.0");
    expect(screen.getByText("בעיה חוסמת אחת")).toBeVisible();
    expect(screen.getByText("שתי אזהרות")).toBeVisible();
    expect(screen.getByText("CORE_VERSION_TOO_OLD")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(screen.getByRole("button", { name: "התקנת טיוטה" })).toBeDisabled();
    expect(
      screen.getByText("יש לפתור את הבעיות החוסמות לפני ההתקנה."),
    ).toBeVisible();
    expect(coursePackages.install).not.toHaveBeenCalled();
    // Refusal codes map to Hebrew; an unknown code keeps the code in a generic sentence.
    expect(packageMessage("GITHUB_RELEASE_NOT_FOUND", he.t)).toBe(
      "הגרסה הזו לא נמצאה ב-GitHub.",
    );
    expect(stripBidiControls(packageMessage("NEW_CODE", he.t))).toBe(
      "השרת דחה את השלב הזה (NEW_CODE).",
    );
    expect(packageMessage("NEW_CODE")).toBe(
      "The server refused this step (NEW_CODE).",
    );
  });

  it("announces the install status in Hebrew as whole sentences", async () => {
    setup({}, "he");
    await userEvent.upload(
      screen.getByLabelText("קובץ חבילת הקורס"),
      packageFile(),
    );
    await userEvent.click(screen.getByRole("button", { name: "בדיקת החבילה" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "התקנת טיוטה" }),
    );
    await screen.findByRole("heading", { name: /גרסה .*1\.2\.0.* הותקנה/ });
    expect(
      stripBidiControls(
        document.querySelector("[aria-live=polite]")?.textContent ?? "",
      ),
    ).toBe("גרסה 1.2.0 הותקנה. מצב: ממתינה לבדיקה.");
  });
  it("an interrupted upload installs nothing, says how to retry, and the retry works with the same file (I06)", async () => {
    const inspectFile = vi
      .fn()
      .mockRejectedValueOnce(new CoursePackageError("UPLOAD_INTERRUPTED"))
      .mockResolvedValueOnce(preview());
    const { coursePackages } = setup({ inspectFile });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    expect(
      await screen.findByText(
        /The upload stopped before the server received the whole file/,
      ),
    ).toBeVisible();
    expect(coursePackages.install).not.toHaveBeenCalled();
    // The file stays selected: the same button sends it again.
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    await screen.findByRole("heading", {
      name: "Synthetic course · version 1.2.0",
    });
    expect(inspectFile).toHaveBeenCalledTimes(2);
    expect(inspectFile.mock.calls[1]![1]).toBe(inspectFile.mock.calls[0]![1]);
  });

  it("an install the server never confirmed is retried with the same idempotency key", async () => {
    const install = vi
      .fn()
      .mockRejectedValueOnce(new CoursePackageError("INSTALL_UNCONFIRMED"))
      .mockResolvedValueOnce({
        alreadyInstalled: true,
        releaseId: "rel-1",
        installation: installation(),
      });
    setup({ install });
    await userEvent.upload(
      screen.getByLabelText("Course package file"),
      packageFile(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Inspect package" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Install draft" }),
    );
    expect(
      await screen.findByText(
        /The connection dropped before the server confirmed the install/,
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Install draft" }),
    );
    await screen.findByRole("heading", { name: "Release 1.2.0 installed" });
    expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls[1]![1].idempotencyKey).toBe(
      install.mock.calls[0]![1].idempotencyKey,
    );
  });

  it("says a slow step is still working instead of looking stuck", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finish: (value: PackagePreview) => void = () => {};
      setup({
        inspectFile: vi.fn(
          () => new Promise<PackagePreview>((resolve) => (finish = resolve)),
        ),
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.upload(
        screen.getByLabelText("Course package file"),
        packageFile(),
      );
      await user.click(screen.getByRole("button", { name: "Inspect package" }));
      expect(screen.queryByText(/Still working/)).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(SLOW_MS));
      expect(screen.getByText(/Still working/)).toBeVisible();
      finish(preview());
      await screen.findByRole("heading", {
        name: "Synthetic course · version 1.2.0",
      });
      expect(screen.queryByText(/Still working/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
