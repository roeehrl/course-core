import { z } from "zod";
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
export interface ProviderSetupPort {
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
