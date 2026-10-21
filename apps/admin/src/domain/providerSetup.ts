import { z } from "zod";
/** Connection references are public routing handles; login material stays server-side. */
const counter = z.number().int().nonnegative(),
  positive = z.number().int().positive();
export const admissionSchema = z.object({
  allowance: z.object({
    microUsd: positive.max(1000000000),
    tokens: positive.max(1000000000),
  }),
  durationMs: positive.max(86400000),
  timeoutMs: positive.max(120000),
  maxAttempts: positive.max(5),
});
export type Admission = z.infer<typeof admissionSchema>;
export const providerSetupSchema = z.object({
  revision: counter,
  configuration: z.unknown(),
  jobPolicy: admissionSchema,
  tokenBounds: z.record(z.string(), counter),
  credentials: z
    .array(z.object({ name: z.string().max(128), configured: z.boolean() }))
    .max(20),
  models: z
    .array(
      z.object({
        id: z.string().max(2048),
        providerId: z.string().max(128),
        enabled: z.boolean(),
        capabilities: z.array(z.string().max(128)),
        configuration: z.enum(["configured", "absent"]),
        verification: z.literal("not_run"),
      }),
    )
    .max(20),
  roles: z.record(
    z.string(),
    z.object({
      status: z.enum(["ready", "configuration_missing", "capability_missing"]),
    }),
  ),
  verification: z.literal("not_run"),
  storage: z.literal("encrypted_server_vault"),
  budgetIsSeparate: z.literal(true),
  metadataKinds: z
    .array(
      z.object({
        kind: z.string().max(100),
        label: z.string().max(128),
        guided: z.boolean(),
        /** Metadata method each role needs from this provider; media null = not offered. */
        roleMethods: z
          .object({
            companion: z.string().max(128),
            supervisor: z.string().max(128),
            research: z.string().max(128),
            reviewer: z.string().max(128),
            media: z
              .object({
                image: z.string().max(128),
                video: z.string().max(128),
              })
              .nullable(),
          })
          .nullable()
          .optional(),
        /** Documentation links (never prices). Older servers omit them. */
        pricingUrl: z.string().url().max(500).nullable().optional(),
        keyHelpUrl: z.string().url().max(500).nullable().optional(),
      }),
    )
    .max(20)
    .default([]),
});
export type ProviderSetup = z.infer<typeof providerSetupSchema>;
const ledger = z.object({
  revision: counter,
  limit_micro_usd: z.string().regex(/^\d+$/),
  limit_tokens: z.string().regex(/^\d+$/),
  used_micro_usd: z.string().regex(/^\d+$/),
  used_tokens: z.string().regex(/^\d+$/),
});
export const providerBudgetsSchema = z.object({
  workspace: ledger,
  enrollments: z.array(ledger.extend({ enrollmentId: z.string() })).max(100),
  maximumEnrollments: z.literal(100),
  usedIncludesReservations: z.literal(true),
  configurationGrantsNoBudget: z.literal(true),
});
export type ProviderBudgets = z.infer<typeof providerBudgetsSchema>;
export const setupReceiptSchema = z.object({
  revision: positive,
  configurationSaved: z.literal(true),
  verification: z.literal("not_run"),
  cancelledPendingJobs: counter,
  budgetChanged: z.literal(false),
});
export const budgetReceiptSchema = z.object({
  revision: positive,
  limits: z.object({ microUsd: counter, tokens: counter }),
  scope: z.enum(["workspace", "enrollment"]),
  doesNotGrantMastery: z.literal(true),
  consentRecorded: z.boolean(),
});
export const modelCatalogSchema = z.object({
  models: z
    .array(
      z.object({
        remoteModel: z.string().max(2048),
        displayName: z.string().max(128),
        description: z.string().max(2000),
        inputTokenLimit: positive.nullable(),
        outputTokenLimit: positive.nullable(),
        methods: z.array(z.string().max(128)).max(32),
      }),
    )
    .max(400),
  truncated: z.boolean(),
  pages: positive.max(4),
  generationPerformed: z.literal(false),
  capabilitiesVerified: z.literal(false),
});
export const inspectionSchema = z.object({
  id: z.string(),
  state: z.enum(["in_flight", "complete", "failed"]),
  result: modelCatalogSchema.nullable(),
  reason: z.string().nullable(),
});
export type ModelInspection = z.infer<typeof inspectionSchema>;
export const modelPreviewSchema = z.object({
  configuration: z.unknown(),
  tokenBounds: z.record(z.string(), counter),
  minimumTokens: positive,
  paidBudgetChanged: z.literal(false),
  capabilitiesVerified: z.literal(false),
  generationPerformed: z.literal(false),
});
export type ModelPreview = z.infer<typeof modelPreviewSchema>;
/** The result of testing a typed key: `outcome` is "ok" or a failure reason code. */
export const keyTestSchema = z.object({
  kind: z.string().max(100),
  outcome: z.string().regex(/^(?:ok|PROVIDER_[A-Z_]{1,80})$/),
  modelCount: counter.nullable(),
  truncated: z.boolean().nullable(),
  stored: z.literal(false),
  generationPerformed: z.literal(false),
});
export type KeyTest = z.infer<typeof keyTestSchema>;
/** Whitespace and invisible characters a copy and paste can add around a key. The server
 * removes the same characters; trimming here keeps the tested and the saved key identical. */
export function trimKey(value: string) {
  return value.replace(
    /^[\s\u200b-\u200d\u2060\ufeff]+|[\s\u200b-\u200d\u2060\ufeff]+$/g,
    "",
  );
}
export interface ProviderSetupPort {
  inspectModels?(
    workspace: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      adapterId: string;
    },
  ): Promise<ModelInspection>;
  previewModels?(
    workspace: string,
    input: {
      expectedRevision: number;
      inspectionId: string;
      assignments: Record<string, unknown>;
    },
  ): Promise<ModelPreview>;
  /** Tests a typed key with the provider's metadata listing. The key is not stored. */
  testKey?(
    workspace: string,
    input: { kind: string; key: string },
  ): Promise<KeyTest>;
  readonly accountId?: string | undefined;
  read(workspace: string, signal?: AbortSignal): Promise<ProviderSetup>;
  budgets(workspace: string, signal?: AbortSignal): Promise<ProviderBudgets>;
  save(
    workspace: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      configuration: unknown;
      jobPolicy: Admission;
      credentials: Record<string, string | null>;
    },
  ): Promise<z.infer<typeof setupReceiptSchema>>;
  saveBudget(
    workspace: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      enrollmentId?: string;
      limits: { microUsd: number; tokens: number };
      paidWorkApproved: boolean;
    },
  ): Promise<z.infer<typeof budgetReceiptSchema>>;
}
