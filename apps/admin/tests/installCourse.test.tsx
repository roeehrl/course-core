import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InstallCourse } from "../src/components/InstallCourse";
import type { AdminClient } from "../src/domain/contracts";
import { CoursePackageError, type Installation, type PackagePreview } from "../src/domain/coursePackages";

// Synthetic course identities only.
const digest = "a".repeat(64);
function preview(overrides: Partial<PackagePreview> = {}): PackagePreview {
  return {
    sha256: "b".repeat(64),
    compressedBytes: 2048,
    course: { id: "synthetic", title: "Synthetic course", version: "1.2.0", digest },
    sdk: { packageVersion: "0.5.0", coreVersion: "0.5.0", supported: { min: "0.5.0", maxExclusive: "0.6.0" }, status: "supported" },
    core: { minimumVersion: "0.1.0", version: "0.1.46", satisfied: true },
    existing: { status: "new-version", catalogId: "cat-1", newestVersion: "1.1.0" },
    registry: { present: true, digest: "c".repeat(64), profileCount: 2, approvable: true },
    hostRequirements: [
      { name: "fixture.py", sha256: "d".repeat(64), bytes: 10, status: "identical" },
      { name: "verifier.json", sha256: "e".repeat(64), bytes: 10, status: "missing" },
    ],
    runtime: { runnable: true },
    members: [{ name: "course.json", role: "course-manifest", bytes: 100 }],
    problems: [{ code: "HOST_REQUIREMENT_MISSING", severity: "warning", detail: "verifier.json: configure it." }],
    installable: true,
    permissions: { install: true, approveAndPublish: true, approveRegistry: true },
    packageSource: { kind: "upload" },
    expiresAt: "2026-10-19T12:00:00Z",
    ...overrides,
  };
}
function installation(overrides: Partial<Installation> = {}): Installation {
  return {
    releaseId: "rel-1", catalogId: "cat-2", catalogRevision: "4", workspaceId: "ws-1",
    course: { id: "synthetic", title: "Synthetic course", version: "1.2.0", digest },
    state: "pending_review", availableForNewLearners: false,
    package: { sha256: "b".repeat(64), source: { kind: "upload" }, sdkVersion: "0.5.0", minimumCoreVersion: "0.1.0", installedAt: "2026-10-19T12:00:00Z" },
    registry: { present: true, digest: "c".repeat(64), profileCount: 2, registryRevision: 0, approved: false },
    permissions: { approve: true, publish: true, approveRegistry: true },
    ...overrides,
  };
}
function setup(port: Partial<NonNullable<AdminClient["coursePackages"]>> = {}) {
  const coursePackages = {
    inspectFile: vi.fn(async () => preview()),
    inspectUrl: vi.fn(async () => preview({ packageSource: { kind: "github", owner: "example", repo: "course", tag: "v1.2.0", asset: "course.course.tgz", checksumVerified: true } })),
    install: vi.fn(async () => ({ alreadyInstalled: false, releaseId: "rel-1", installation: installation() })),
    installation: vi.fn(async () => installation()),
    approveRegistry: vi.fn(async () => installation({ registry: { present: true, digest: "c".repeat(64), profileCount: 2, registryRevision: 1, approved: true } })),
    ...port,
  };
  const transitionRelease = vi.fn(async () => ({}));
  const client = { mode: "connected", coursePackages, transitionRelease } as unknown as AdminClient;
  const onFinished = vi.fn();
  render(<InstallCourse client={client} workspaceId="ws-1" onFinished={onFinished} />);
  return { coursePackages, transitionRelease, onFinished };
}
const packageFile = () => new File([new Uint8Array([0x1f, 0x8b, 1, 2])], "synthetic-1.2.0.course.tgz", { type: "application/gzip" });

describe("installing a course package", () => {
  it("inspects an uploaded file, shows the preview and installs a draft in review", async () => {
    const { coursePackages, onFinished } = setup();
    const input = screen.getByLabelText("Course package file");
    expect(input).toHaveAttribute("accept", ".tgz,.course.tgz,application/gzip");
    expect(input).toHaveAccessibleDescription(/\.course\.tgz file, at most 64 MiB/);
    await userEvent.upload(input, packageFile());
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    const heading = await screen.findByRole("heading", { name: "Synthetic course · version 1.2.0" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(coursePackages.inspectFile).toHaveBeenCalledWith("ws-1", expect.any(File));
    expect(screen.getByText(/Package checked: Synthetic course 1\.2\.0\. No blocking problems\./)).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Present, identical")).toBeVisible();
    expect(screen.getByText("Missing on this host")).toBeVisible();
    expect(screen.getByText(/1 warning/)).toBeVisible();
    expect(screen.getByText(/2 profiles · digest cccccccccccc…/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Install draft" }));
    expect(await screen.findByRole("heading", { name: "Release 1.2.0 installed" })).toHaveFocus();
    expect(coursePackages.install).toHaveBeenCalledWith("b".repeat(64), { workspaceId: "ws-1", idempotencyKey: expect.stringMatching(/^package-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/) });
    expect(screen.getByText(/Version 1.2.0 installed. State: pending review./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done — open this course" }));
    expect(onFinished).toHaveBeenCalledWith("cat-2");
  });

  it("blocks installation while there are blocking problems and lists them first", async () => {
    setup({ inspectFile: vi.fn(async () => preview({ installable: false, problems: [{ code: "CORE_VERSION_TOO_OLD", severity: "blocking", detail: "Requires Core 9.0.0." }] })) });
    await userEvent.upload(screen.getByLabelText("Course package file"), packageFile());
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 blocking problemCORE_VERSION_TOO_OLD — Requires Core 9.0.0.");
    expect(screen.getByRole("button", { name: "Install draft" })).toBeDisabled();
    expect(screen.getByText("Resolve the blocking problems before installing.")).toBeVisible();
  });

  it("requires the exact version before installing, approving and publishing at once", async () => {
    const { coursePackages } = setup();
    await userEvent.upload(screen.getByLabelText("Course package file"), packageFile());
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Also approve the review and publish this version now" }));
    const submit = screen.getByRole("button", { name: "Install, approve and publish" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type 1.2.0 to confirm publication"), "1.2");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type 1.2.0 to confirm publication"), ".0");
    await userEvent.click(screen.getByRole("checkbox", { name: /Also approve the packaged recovery registry \(digest cccccccccccc…\)/ }));
    await userEvent.click(submit);
    await waitFor(() => expect(coursePackages.install).toHaveBeenCalledWith("b".repeat(64), expect.objectContaining({
      approveAndPublish: { confirmVersion: "1.2.0" }, approveRegistry: { configurationDigest: "c".repeat(64) } })));
  });

  it("does not offer approve-and-publish without both permissions", async () => {
    setup({ inspectFile: vi.fn(async () => preview({ permissions: { install: true, approveAndPublish: false, approveRegistry: false } })) });
    await userEvent.upload(screen.getByLabelText("Course package file"), packageFile());
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    await screen.findByRole("button", { name: "Install draft" });
    expect(screen.queryByRole("checkbox", { name: /publish/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /registry/ })).toBeNull();
  });

  it("asks for a choice when a GitHub release has several packages", async () => {
    const inspectUrl = vi.fn()
      .mockRejectedValueOnce(new CoursePackageError("COURSE_PACKAGE_ASSET_CHOICE_REQUIRED", { assets: ["a.course.tgz", "b.course.tgz"] }))
      .mockResolvedValueOnce(preview());
    setup({ inspectUrl });
    await userEvent.click(screen.getByRole("radio", { name: "From GitHub" }));
    const url = screen.getByLabelText("GitHub link");
    expect(url).toHaveAccessibleDescription(/https:\/\/github\.com\/owner\/course\/releases\/tag\/v1\.2\.0/);
    await userEvent.type(url, "https://github.com/example/course");
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The release has several course packages. Choose one.");
    const inspect = screen.getByRole("button", { name: "Inspect package" });
    expect(inspect).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Package in this release"), "b.course.tgz");
    await userEvent.click(inspect);
    await screen.findByRole("heading", { name: "Synthetic course · version 1.2.0" });
    expect(inspectUrl).toHaveBeenLastCalledWith("ws-1", "https://github.com/example/course", "b.course.tgz");
  });

  it("shows a clear refusal for a private or missing repository", async () => {
    setup({ inspectUrl: vi.fn(async () => { throw new CoursePackageError("GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING"); }) });
    await userEvent.click(screen.getByRole("radio", { name: "From GitHub" }));
    await userEvent.type(screen.getByLabelText("GitHub link"), "https://github.com/example/private");
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That GitHub repository does not exist or is not public.");
  });

  it("runs approve, publish and registry approval with explicit confirmations", async () => {
    const states = [installation({ state: "approved", catalogRevision: "5" }), installation({ state: "published", availableForNewLearners: true, catalogRevision: "6" })];
    const { coursePackages, transitionRelease } = setup({ installation: vi.fn(async () => states.shift() ?? installation({ state: "published" })) });
    await userEvent.upload(screen.getByLabelText("Course package file"), packageFile());
    await userEvent.click(screen.getByRole("button", { name: "Inspect package" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install draft" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve review" }));
    await waitFor(() => expect(transitionRelease).toHaveBeenCalledWith("cat-2", "rel-1", "approve", expect.objectContaining({ expectedRevision: "4" })));
    const confirm = await screen.findByRole("button", { name: "Confirm publication" });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "I confirm publication of version 1.2.0." }));
    await userEvent.click(confirm);
    await waitFor(() => expect(transitionRelease).toHaveBeenCalledWith("cat-2", "rel-1", "publish", expect.objectContaining({ expectedRevision: "5" })));
    expect(await screen.findByText("Available to new learners")).toBeVisible();
    const approveRegistry = screen.getByRole("button", { name: "Approve recovery registry" });
    expect(approveRegistry).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /I approve the packaged recovery registry \(2 profiles, digest cccccccccccc…\) for version 1\.2\.0/ }));
    await userEvent.click(approveRegistry);
    await waitFor(() => expect(coursePackages.approveRegistry).toHaveBeenCalledWith("rel-1", { configurationDigest: "c".repeat(64), expectedRegistryRevision: 0 }));
  });
});
