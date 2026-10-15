import { z } from "zod";
/** Connection references are public routing handles; login material stays server-side. */
export function subscriptionConnections(
  configuration: string,
): { id: string; enabled: boolean; credentialEnv: string }[] {
  try {
    const value = JSON.parse(configuration);
    if (!Array.isArray(value?.adapters)) return [];
    return value.adapters
      .filter(
        (a: any) =>
          typeof a?.id === "string" && typeof a.subscriptionRef === "string",
      )
      .map((a: any) => ({
        id: a.id as string,
        enabled: a.automaticFallback?.enabled === true,
        credentialEnv:
          typeof a.automaticFallback?.credentialEnv === "string"
            ? (a.automaticFallback.credentialEnv as string)
            : "",
      }));
  } catch {
    return [];
  }
}
export function updateSubscriptionFallback(
  configuration: string,
  connectionId: string,
  update: { enabled?: boolean; credentialEnv?: string },
) {
  const value = JSON.parse(configuration);
  const connections = value?.adapters?.filter(
    (a: any) => a?.id === connectionId && typeof a.subscriptionRef === "string",
  );
  if (!Array.isArray(connections) || connections.length !== 1)
    throw Error("Select one subscription connection.");
  const connection = connections[0],
    fallback = {
      enabled: connection.automaticFallback?.enabled === true,
      ...connection.automaticFallback,
      ...update,
    };
  if (!fallback.credentialEnv) delete fallback.credentialEnv;
  connection.automaticFallback = fallback;
  return JSON.stringify(value, null, 2);
}
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
export function usdToMicro(value: string) {
  if (!/^\d{1,4}(?:\.\d{1,6})?$/.test(value))
    throw Error("Enter USD with up to six decimal places.");
  const [whole, fraction = ""] = value.split("."),
    units = Number(BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0")));
  if (units > 1000000000) throw Error("The current maximum is 1,000 USD.");
  return units;
}
export function microToUsd(value: number | string) {
  const units = BigInt(value);
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, "0")}`;
}
