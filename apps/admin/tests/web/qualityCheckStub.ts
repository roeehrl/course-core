import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The connected AI services page with a finished, failed quality check of an open draft, served
 * by route fixtures. The conversation details (`qualityCheckDetails.json`) were produced from Core's
 * public practice conversations answered by the offline scripted models (some answers from the
 * known-bad model), graded by Core's graders: no provider was called and no learner data is in it.
 */
export const details = JSON.parse(
  readFileSync(new URL("./qualityCheckDetails.json", import.meta.url), "utf8"),
) as {
  checkId: string;
  roles: {
    role: string;
    dialogues: {
      dialogueId: string;
      passed: boolean;
      graders: { grader: string; passed: boolean }[];
    }[];
  }[];
};
const draftId = "00000000-0000-4000-8000-0000000000d1";
const jobPolicy = {
  allowance: { microUsd: 100000, tokens: 600000 },
  durationMs: 300000,
  timeoutMs: 60000,
  maxAttempts: 3,
};
const roles = details.roles.map((r) => r.role);
const now = new Date().toISOString();
const setup = {
  revision: 2,
  configuration: {
    registry: { revision: "x", models: [] },
    adapters: [
      {
        id: "connection-1",
        kind: "google",
        credentialEnv: "COURSE_PROVIDER_0123456789ABCDEF_API_KEY",
      },
    ],
    roles: {},
  },
  jobPolicy,
  tokenBounds: {},
  credentials: [],
  models: [],
  roles: {},
  verification: "not_run",
  storage: "encrypted_server_vault",
  budgetIsSeparate: true,
  metadataKinds: [
    {
      kind: "google",
      label: "Google",
      guided: true,
      pricingUrl: "https://example.org/pricing",
      keyHelpUrl: "https://example.org/key",
    },
  ],
};
const draft = {
  id: draftId,
  baseRevision: 2,
  source: "models",
  stale: false,
  roles: roles.map((role) => ({
    role,
    modelId: `connection-1:${role}`,
    connectionId: "connection-1",
    remoteModel:
      role === "media" ? "gemini-3.1-flash-image" : "gemini-3.8-flash",
    mediaKind: role === "media" ? "image" : null,
    check: "failed",
    priced: true,
    changed: true,
  })),
  removedRoles: [],
  jobPolicy,
  waitingForCheck: roles,
  updatedAt: now,
  secretsIncluded: false,
};
export const failedCheck = {
  id: details.checkId,
  target: "draft",
  draftId,
  state: "failed",
  reason: null,
  reasonDetail: null,
  roles,
  total: details.roles.reduce((n, r) => n + r.dialogues.length, 0),
  completed: details.roles.reduce((n, r) => n + r.dialogues.length, 0),
  estimateMicroUsd: 60000,
  reservedMicroUsd: 1000000,
  chargedMicroUsd: 41000,
  outcome: details.roles.map((r) => ({
    role: r.role,
    passed: r.dialogues.every((d) => d.passed),
    dialogues: r.dialogues.length,
    failed: r.dialogues
      .filter((d) => !d.passed)
      .map((d) => ({
        dialogueId: d.dialogueId,
        graders: d.graders.filter((g) => !g.passed).map((g) => g.grader),
      })),
  })),
  createdAt: now,
  finishedAt: now,
  deadlineAt: now,
};

/** Routes the AI services API; `recorded: false` serves a check an older Core ran (no details kept). */
export async function stubQualityCheck(
  page: Page,
  options: { recorded?: boolean } = {},
) {
  const requests = { details: 0 };
  const ws = "**/api/admin/workspaces/*";
  await page.route(`${ws}/provider-setup`, (route) =>
    route.fulfill({ json: setup }),
  );
  await page.route(`${ws}/provider-setup/connections`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        connections: [
          {
            id: "connection-1",
            kind: "google",
            label: "Google",
            name: "",
            keyEnding: "7Q2c",
            keyStored: true,
            keyStatus: "working",
            keyReason: null,
            testedAt: now,
            usedByRoles: [],
          },
        ],
        serviceKeys: [],
        keyStorage: "encrypted_server_vault",
      },
    }),
  );
  await page.route(`${ws}/provider-setup/drafts/current`, (route) =>
    route.fulfill({ json: { draft } }),
  );
  await page.route(`${ws}/provider-pricing`, (route) =>
    route.fulfill({
      json: {
        requirePricing: true,
        settingsRevision: 0,
        currency: "USD",
        builtInPrices: false,
        models: [],
      },
    }),
  );
  await page.route(`${ws}/provider-setup/budgets`, (route) =>
    route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }),
  );
  await page.route(`${ws}/provider-evals`, (route) =>
    route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }),
  );
  await page.route(`${ws}/provider-setup/quality-check`, (route) =>
    route.fulfill({
      json: {
        target: "draft",
        draftId,
        roles: roles.map((role) => ({
          role,
          remoteModel: "gemini-3.8-flash",
          conversations: 2,
          priced: true,
          estimateMicroUsd: 12000,
        })),
        conversations: failedCheck.total,
        estimateMicroUsd: 60000,
        reserveMicroUsd: 1000000,
        blocked: null,
        latest: failedCheck,
        activeRoles: [],
      },
    }),
  );
  await page.route(`${ws}/provider-setup/quality-check/*`, (route) =>
    route.fulfill({ json: failedCheck }),
  );
  await page.route(`${ws}/provider-setup/quality-check/*/details`, (route) => {
    requests.details++;
    return route.fulfill({
      json:
        options.recorded === false
          ? {
              checkId: details.checkId,
              state: "failed",
              recorded: false,
              roles: [],
            }
          : details,
    });
  });
  return requests;
}
