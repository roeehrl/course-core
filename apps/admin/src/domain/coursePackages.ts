import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(4000);
const problemSchema = z.object({
  code: z.string().max(100),
  severity: z.enum(["blocking", "warning"]),
  detail: text.optional(),
});
export const packageSourceSchema = z.union([
  z.object({ kind: z.literal("upload") }),
  z.object({ kind: z.literal("path"), directoryId: z.string(), directory: z.string().max(255), subpath: z.string().max(1024), file: z.string().max(255).nullable() }),
  z.object({
    kind: z.literal("github"),
    owner: z.string().max(100),
    repo: z.string().max(100),
    tag: z.string().max(200),
    asset: z.string().max(200),
    checksumVerified: z.boolean(),
  }),
]);
export const packagePreviewSchema = z.object({
  sha256: digest,
  compressedBytes: z.number().int().nonnegative(),
  course: z.object({ id: text, title: text, version: text, digest }),
  sdk: z.object({
    packageVersion: text,
    coreVersion: text,
    supported: z.object({ min: text, maxExclusive: text }),
    status: z.enum(["supported", "newer", "older", "unsupported"]),
  }),
  core: z.object({ minimumVersion: text, version: text, satisfied: z.boolean() }),
  existing: z.object({
    status: z.enum(["new-course", "new-version", "already-installed", "version-conflict"]),
    catalogId: z.string().nullable(),
    newestVersion: text.nullable(),
    releaseId: z.string().optional(),
    releaseStatus: text.optional(),
  }),
  registry: z.union([
    z.object({ present: z.literal(false) }),
    z.object({ present: z.literal(true), digest, profileCount: z.number().int().nonnegative(), approvable: z.boolean(), code: text.optional() }),
  ]),
  hostRequirements: z.array(z.object({ name: text, sha256: digest, bytes: z.number().int().nonnegative(), status: z.enum(["identical", "different", "missing"]) })).max(200),
  runtime: z.object({ runnable: z.boolean(), code: text.optional() }),
  members: z.array(z.object({ name: text, role: text, bytes: z.number().int().nonnegative() })).max(200),
  problems: z.array(problemSchema).max(500),
  installable: z.boolean(),
  permissions: z.object({ install: z.boolean(), approveAndPublish: z.boolean(), approveRegistry: z.boolean() }),
  packageSource: packageSourceSchema,
  expiresAt: text,
});
export type PackagePreview = z.infer<typeof packagePreviewSchema>;
export const installationSchema = z.object({
  releaseId: z.string(),
  catalogId: z.string(),
  catalogRevision: z.string(),
  workspaceId: z.string(),
  course: z.object({ id: text, title: text, version: text, digest }),
  state: z.enum(["draft", "pending_review", "approved", "published", "archived"]),
  availableForNewLearners: z.boolean(),
  package: z.object({ sha256: digest, source: packageSourceSchema, sdkVersion: text, minimumCoreVersion: text, installedAt: text }),
  registry: z.union([
    z.object({ present: z.literal(false) }),
    z.object({ present: z.literal(true), digest, profileCount: z.number().int().nonnegative(), registryRevision: z.number().int().nonnegative(), approved: z.boolean() }),
  ]),
  permissions: z.object({ approve: z.boolean(), publish: z.boolean(), approveRegistry: z.boolean() }),
});
export type Installation = z.infer<typeof installationSchema>;
export const installResultSchema = z.object({
  alreadyInstalled: z.boolean(),
  releaseId: z.string(),
  installation: installationSchema.nullable(),
  registryApproval: z
    .union([z.object({ approved: z.literal(true), registryRevision: z.number().int() }), z.object({ approved: z.literal(false), code: text })])
    .optional(),
});
export type InstallResult = z.infer<typeof installResultSchema>;

export class CoursePackageError extends Error {
  constructor(
    readonly code: string,
    readonly details?: { assets?: string[] },
  ) {
    super(code);
  }
}
export interface CoursePackagePort {
  inspectFile(workspaceId: string, file: Blob, signal?: AbortSignal): Promise<PackagePreview>;
  inspectUrl(workspaceId: string, url: string, asset?: string, signal?: AbortSignal): Promise<PackagePreview>;
  install(
    sha256: string,
    input: {
      workspaceId: string;
      idempotencyKey: string;
      notes?: string;
      approveAndPublish?: { confirmVersion: string };
      approveRegistry?: { configurationDigest: string };
    },
  ): Promise<InstallResult>;
  installation(releaseId: string, signal?: AbortSignal): Promise<Installation>;
  approveRegistry(releaseId: string, input: { configurationDigest: string; expectedRegistryRevision: number }): Promise<Installation>;
}

const messages: Record<string, string> = {
  PACKAGE_NOT_GZIP: "This file is not a gzip-compressed course package (.course.tgz).",
  PACKAGE_CORRUPT: "The package archive is damaged or not a plain POSIX tar archive.",
  PACKAGE_TOO_LARGE: "The package is larger than the limits (64 MiB compressed, 32 MiB per file, 128 MiB in total).",
  PACKAGE_TOO_MANY_MEMBERS: "The package holds more than 200 files.",
  PACKAGE_LINK_ENTRY: "The package contains a link. Only regular files are accepted.",
  PACKAGE_UNSUPPORTED_ENTRY: "The package contains a directory, device or extension record. Only top-level regular files are accepted.",
  PACKAGE_UNSAFE_PATH: "The package contains a file path outside its top level.",
  PACKAGE_INVALID_MEMBER_NAME: "The package contains a file name that is not allowed.",
  PACKAGE_DUPLICATE_MEMBER: "The package contains the same file twice.",
  PACKAGE_LISTING_MISSING: "The package has no course-package.json.",
  PACKAGE_LISTING_INVALID: "course-package.json is not a valid course-package v1 listing.",
  PACKAGE_UNSUPPORTED_FORMAT: "This package format version is not supported.",
  PACKAGE_UNKNOWN_KEY: "course-package.json has a field this Core does not know.",
  PACKAGE_UNKNOWN_ROLE: "A package file has a role this Core does not know.",
  PACKAGE_DUPLICATE_LISTING: "course-package.json lists the same file twice.",
  PACKAGE_UNLISTED_MEMBER: "The package contains a file its listing does not declare.",
  PACKAGE_MISSING_MEMBER: "A file the listing declares is missing from the package.",
  PACKAGE_MEMBER_SIZE_MISMATCH: "A package file's size does not match its listing.",
  PACKAGE_MEMBER_DIGEST_MISMATCH: "A package file's contents do not match its listed SHA-256.",
  PACKAGE_ROLE_COUNT: "The package must hold exactly one course manifest and at most one learner projection and one registry.",
  PACKAGE_MEMBER_NOT_JSON: "A JSON file in the package is not valid UTF-8 JSON.",
  PACKAGE_COMPILED_WRAPPER: "The course manifest is a compiled bundle. Package the source manifest instead.",
  PACKAGE_COURSE_INVALID: "The course manifest does not pass validation.",
  PACKAGE_COURSE_ID_MISMATCH: "The course manifest's id differs from the package listing.",
  PACKAGE_COURSE_VERSION_MISMATCH: "The course manifest's version differs from the package listing.",
  PACKAGE_COURSE_DIGEST_MISMATCH: "The course digest Core computes differs from the package listing.",
  PACKAGE_LEARNER_MISMATCH: "The packaged learner projection differs from the one Core compiles.",
  PACKAGE_CHECKSUM_INVALID: "The release's .sha256 file is not one sha256sum line naming the package.",
  PACKAGE_CHECKSUM_MISMATCH: "The package does not match the release's .sha256 checksum.",
  COURSE_PACKAGE_URL_UNSUPPORTED: "Use a github.com repository, release or release-asset link.",
  COURSE_PACKAGE_REMOTE_FETCH_DISABLED: "Installing from links is turned off on this host. Upload the package file instead.",
  GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING: "That GitHub repository does not exist or is not public.",
  GITHUB_RELEASE_NOT_FOUND: "That GitHub release was not found.",
  GITHUB_RATE_LIMITED: "GitHub is limiting requests from this host. Try again later or upload the file.",
  GITHUB_UNAVAILABLE: "GitHub did not answer as expected. Try again later or upload the file.",
  COURSE_PACKAGE_ASSET_NOT_FOUND: "The release has no matching .course.tgz file.",
  COURSE_PACKAGE_ASSET_CHOICE_REQUIRED: "The release has several course packages. Choose one.",
  COURSE_PACKAGE_REDIRECT_REFUSED: "The download left GitHub's release hosts and was stopped.",
  COURSE_PACKAGE_TOO_MANY_REDIRECTS: "The download redirected too many times and was stopped.",
  COURSE_PACKAGE_FETCH_TIMEOUT: "The download timed out.",
  COURSE_PACKAGE_FETCH_FAILED: "The package could not be downloaded.",
  COURSE_PACKAGE_NOT_STAGED: "The inspected package expired. Inspect it again.",
  PUBLISH_CONFIRMATION_REQUIRED: "Type the exact version to confirm publication.",
  RELEASE_VERSION_CONFLICT: "This version already exists here with different content.",
  CORE_VERSION_TOO_OLD: "This course needs a newer Core.",
  SDK_UNSUPPORTED: "This course was compiled with an SDK this Core does not support.",
  ADAPTATION_REGISTRY_DIGEST_MISMATCH: "The registry changed since it was shown. Reload before approving.",
  STALE_REGISTRY: "The registry was changed by someone else. Reload before approving.",
  COURSE_UPDATE_SOURCE_REQUIRED: "Choose an update source first.",
  COURSE_UPDATE_WRONG_COURSE: "The package at the update source is for a different course.",
  COURSE_PACKAGE_PATH_INVALID: "Use a relative folder path inside the chosen package directory.",
  COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY: "That path leads outside the package directory and was refused.",
  COURSE_PACKAGE_PATH_NOT_FOUND: "Nothing exists at that path inside the package directory.",
  COURSE_PACKAGE_PATH_NOT_PACKAGE: "That file is not a .course.tgz package.",
  COURSE_PACKAGE_DIRECTORY_UNKNOWN: "That package directory is not configured on this host.",
  COURSE_PACKAGE_DIRECTORY_UNAVAILABLE: "That package directory is not available on this host.",
  COURSE_PACKAGE_TOO_MANY_CANDIDATES: "The folder holds more than 50 package files.",
  AUTO_PUBLISH_ACKNOWLEDGEMENT_REQUIRED: "Confirm the automatic publication acknowledgement.",
  AUTOMATIC_UPDATE_FORBIDDEN: "The person who saved the automatic setting no longer has the permissions it needs.",
  STALE_REVISION: "Someone else changed these settings. Reload and try again.",
  FORBIDDEN: "Your role cannot do this.",
  UNAVAILABLE: "The server could not be reached.",
};
export const packageMessage = (code: string) => messages[code] ?? `The server refused this step (${code}).`;
