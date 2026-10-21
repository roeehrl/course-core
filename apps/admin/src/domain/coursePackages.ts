import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";
import { en } from "../i18n/catalog";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(4000);
const problemSchema = z.object({
  code: z.string().max(100),
  severity: z.enum(["blocking", "warning"]),
  detail: text.optional(),
});
export const packageSourceSchema = z.union([
  z.object({ kind: z.literal("upload") }),
  z.object({
    kind: z.literal("path"),
    directoryId: z.string(),
    directory: z.string().max(255),
    subpath: z.string().max(1024),
    file: z.string().max(255).nullable(),
  }),
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
  core: z.object({
    minimumVersion: text,
    version: text,
    satisfied: z.boolean(),
  }),
  existing: z.object({
    status: z.enum([
      "new-course",
      "new-version",
      "already-installed",
      "version-conflict",
    ]),
    catalogId: z.string().nullable(),
    newestVersion: text.nullable(),
    releaseId: z.string().optional(),
    releaseStatus: text.optional(),
  }),
  registry: z.union([
    z.object({ present: z.literal(false) }),
    z.object({
      present: z.literal(true),
      digest,
      profileCount: z.number().int().nonnegative(),
      approvable: z.boolean(),
      code: text.optional(),
    }),
  ]),
  hostRequirements: z
    .array(
      z.object({
        name: text,
        sha256: digest,
        bytes: z.number().int().nonnegative(),
        status: z.enum(["identical", "different", "missing"]),
      }),
    )
    .max(200),
  runtime: z.object({ runnable: z.boolean(), code: text.optional() }),
  members: z
    .array(
      z.object({
        name: text,
        role: text,
        bytes: z.number().int().nonnegative(),
      }),
    )
    .max(200),
  problems: z.array(problemSchema).max(500),
  installable: z.boolean(),
  permissions: z.object({
    install: z.boolean(),
    approveAndPublish: z.boolean(),
    approveRegistry: z.boolean(),
  }),
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
  state: z.enum([
    "draft",
    "pending_review",
    "approved",
    "published",
    "archived",
  ]),
  availableForNewLearners: z.boolean(),
  package: z.object({
    sha256: digest,
    source: packageSourceSchema,
    sdkVersion: text,
    minimumCoreVersion: text,
    installedAt: text,
  }),
  registry: z.union([
    z.object({ present: z.literal(false) }),
    z.object({
      present: z.literal(true),
      digest,
      profileCount: z.number().int().nonnegative(),
      registryRevision: z.number().int().nonnegative(),
      approved: z.boolean(),
    }),
  ]),
  permissions: z.object({
    approve: z.boolean(),
    publish: z.boolean(),
    approveRegistry: z.boolean(),
  }),
});
export type Installation = z.infer<typeof installationSchema>;
export const installResultSchema = z.object({
  alreadyInstalled: z.boolean(),
  releaseId: z.string(),
  installation: installationSchema.nullable(),
  registryApproval: z
    .union([
      z.object({
        approved: z.literal(true),
        registryRevision: z.number().int(),
      }),
      z.object({ approved: z.literal(false), code: text }),
    ])
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
  inspectFile(
    workspaceId: string,
    file: Blob,
    signal?: AbortSignal,
  ): Promise<PackagePreview>;
  inspectUrl(
    workspaceId: string,
    url: string,
    asset?: string,
    signal?: AbortSignal,
  ): Promise<PackagePreview>;
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
  approveRegistry(
    releaseId: string,
    input: { configurationDigest: string; expectedRegistryRevision: number },
  ): Promise<Installation>;
}

/** A course-package refusal code in the caller's locale; an unknown code is shown in a generic sentence. */
export function packageMessage(
  code: string,
  t: Translate = englishTranslator().t,
): string {
  return Object.hasOwn(en.coursePackages, `error.${code}`)
    ? t(`coursePackages.error.${code}` as MessageKey)
    : t("coursePackages.error.unknown", { code });
}
