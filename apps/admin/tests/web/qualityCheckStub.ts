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

/**
 * The same details as a meaning judge would leave them: the frustrated learner's reply judged by
 * a reviewer model (both judged rules failed, its reasons and the passages it quoted), and the
 * signed-order conversation with a factuality judgement that could not run (no result). Synthetic
 * judge output in the server's stored shape; no model was called.
 */
export function judgedDetails() {
  const copy = structuredClone(details) as unknown as {
    roles: { dialogues: Record<string, unknown>[] }[];
  };
  const judge = { model: "gemini-2.5-pro", self: false, state: "judged" };
  for (const dialogue of copy.roles.flatMap((r) => r.dialogues)) {
    const graders = dialogue.graders as Record<string, unknown>[];
    const set = (grader: string, value: Record<string, unknown>) =>
      Object.assign(
        graders.find((g) => g.grader === grader)!,
        value,
      );
    if (dialogue.dialogueId === "companion.frustrated.total-travel") {
      set("grounding", {
        passed: false,
        judge: {
          ...judge,
          reasons: ["It cites a Chapter 7 that the lesson does not contain."],
        },
        findings: [{ code: "judge_failed", match: "as covered in Chapter 7" }],
      });
      set("factuality", {
        passed: false,
        judge: {
          ...judge,
          reasons: [
            "It gives a total without adding the legs of the route, and the total is wrong.",
          ],
        },
        findings: [{ code: "judge_failed", match: "Total travel is 9" }],
      });
    }
    if (dialogue.dialogueId === "companion.novice.signed-order") {
      dialogue.passed = false;
      dialogue.undetermined = true;
      set("grounding", {
        passed: true,
        judge: { ...judge, reasons: [] },
        findings: [],
      });
      set("factuality", {
        applies: true,
        passed: false,
        undetermined: true,
        judge: {
          ...judge,
          state: "unavailable",
          reason: "timeout",
          reasons: [],
        },
        findings: [{ code: "judge_unavailable:timeout" }],
      });
    }
  }
  return copy;
}

/**
 * The same details with one tutor conversation that got no usable answer: a thinking model used
 * its whole output limit for thinking (the adapter's reason MAX_TOKENS_THINKING), so every rule
 * failed with `no_answer:provider_output_incomplete`. Synthetic, in the server's stored shape.
 */
export function providerFailedDetails() {
  const copy = structuredClone(details) as unknown as {
    roles: { dialogues: Record<string, unknown>[] }[];
  };
  const dialogue = copy.roles
    .flatMap((r) => r.dialogues)
    .find((d) => d.dialogueId === "companion.terse.endpoint-answer")!;
  dialogue.passed = false;
  dialogue.reply = {
    kind: "refusal",
    text: null,
    reason: "provider_output_incomplete",
    providerReason: "MAX_TOKENS_THINKING",
    truncated: false,
  };
  dialogue.graders = (dialogue.graders as Record<string, unknown>[]).map(
    (g) => ({
      ...g,
      applies: true,
      passed: false,
      findings: [{ code: "no_answer:provider_output_incomplete" }],
    }),
  );
  return copy;
}

/** Routes the AI services API; `recorded: false` serves a check an older Core ran (no details kept),
 * `judged` the details a meaning judge left (`judgedDetails`), `providerFailed` a conversation
 * without an answer and the provider's reason (`providerFailedDetails`). */
export async function stubQualityCheck(
  page: Page,
  options: {
    recorded?: boolean;
    judged?: boolean;
    providerFailed?: boolean;
  } = {},
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
          : options.judged
            ? judgedDetails()
            : options.providerFailed
              ? providerFailedDetails()
              : details,
    });
  });
  return requests;
}

/** The two jobs the owner turned on with "Approve without checking". */
const onJobs = ["companion", "supervisor"] as const;
const approvedAt = "2026-10-31T09:00:00.000Z";
/** A failed check of the jobs that are on, with the stored conversations of those two jobs. */
export const failedActiveCheck = {
  ...failedCheck,
  target: "active",
  draftId: null,
  roles: [...onJobs],
  total: details.roles
    .filter((r) => (onJobs as readonly string[]).includes(r.role))
    .reduce((n, r) => n + r.dialogues.length, 0),
  outcome: failedCheck.outcome.filter((o) =>
    (onJobs as readonly string[]).includes(o.role),
  ),
};
failedActiveCheck.completed = failedActiveCheck.total;

/**
 * The connected AI services page with the learner tutor and the lesson planner on, both approved
 * without checking and no draft open. `failed` serves a failed check of both as the latest check.
 * `tutorFailed` is the pilot's case: that check failed the tutor (which stays on and needs a
 * check) and passed the planner.
 */
export async function stubJobsOn(
  page: Page,
  options: { failed?: boolean; tutorFailed?: boolean } = {},
) {
  const requests = { turnOff: [] as unknown[], started: [] as unknown[] };
  const ws = "**/api/admin/workspaces/*";
  const active = {
    ...setup,
    revision: 3,
    configuration: {
      ...setup.configuration,
      registry: {
        revision: "x",
        models: onJobs.map((role) => ({
          id: `connection-1:${role}`,
          providerId: "connection-1",
          remoteModel: "gemini-3.8-flash",
        })),
      },
      roles: Object.fromEntries(
        onJobs.map((role) => [role, { modelId: `connection-1:${role}` }]),
      ),
    },
  };
  await page.route(`${ws}/provider-setup`, (route) =>
    route.fulfill({ json: active }),
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
            usedByRoles: [...onJobs],
          },
        ],
        serviceKeys: [],
        keyStorage: "encrypted_server_vault",
      },
    }),
  );
  await page.route(`${ws}/provider-setup/drafts/current`, (route) =>
    route.fulfill({ json: { draft: null } }),
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
    route.fulfill({
      json: {
        suite: {
          id: "core-public",
          version: "2",
          digest: "f".repeat(64),
          dialogues: 18,
          coverage: [{ role: "companion", dialogues: 9 }],
        },
        providerRevision: 3,
        gatedAtActivation: true,
        roles: onJobs.map((role, i) =>
          options.tutorFailed
            ? {
                role,
                strategy: `core.${role}`,
                revisionDigest: String(i).repeat(64),
                covered: true,
                status: role === "companion" ? "failed" : "passed",
                grandfathered: false,
                activatedBy: "override",
                ...(role === "companion" ? {} : { evaluatedAt: approvedAt }),
              }
            : {
                role,
                strategy: `core.${role}`,
                revisionDigest: String(i).repeat(64),
                covered: true,
                status: "override",
                grandfathered: false,
                activatedBy: "override",
                overrideId: `00000000-0000-4000-8000-00000000000${i}`,
                overriddenAt: approvedAt,
              },
        ),
        results: [],
        overrides: [],
      },
    }),
  );
  const plan = (role: string, conversations: number) => ({
    role,
    remoteModel: "gemini-3.8-flash",
    conversations,
    priced: true,
    estimateMicroUsd: conversations * 6000,
    reserveMicroUsd: conversations * 100000,
    blocked: null,
  });
  await page.route(`${ws}/provider-setup/quality-check`, (route) => {
    if (route.request().method() === "POST") {
      requests.started.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          ...failedActiveCheck,
          state: "running",
          completed: 1,
          finishedAt: null,
          deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      });
    }
    return route.fulfill({
      json: {
        target: null,
        draftId: null,
        roles: [],
        conversations: 0,
        estimateMicroUsd: 0,
        reserveMicroUsd: 0,
        blocked: { code: "PROVIDER_QUALITY_CHECK_NO_DRAFT" },
        latest:
          options.failed || options.tutorFailed ? failedActiveCheck : null,
        activeRoles: options.tutorFailed ? [plan("companion", 9)] : [],
        onRoles: [plan("companion", 9), plan("supervisor", 3)],
        onAll: {
          conversations: 12,
          estimateMicroUsd: 72000,
          reserveMicroUsd: 1200000,
          blocked: null,
        },
      },
    });
  });
  await page.route(`${ws}/provider-setup/quality-check/*`, (route) =>
    route.fulfill({ json: failedActiveCheck }),
  );
  await page.route(`${ws}/provider-setup/quality-check/*/details`, (route) =>
    route.fulfill({
      json: {
        ...details,
        roles: details.roles.filter((r) =>
          (onJobs as readonly string[]).includes(r.role),
        ),
      },
    }),
  );
  await page.route(`${ws}/provider-setup/turn-off`, (route) => {
    requests.turnOff.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        role: "companion",
        revision: 4,
        turnedOff: true,
        cancelledPendingJobs: 0,
      },
    });
  });
  return requests;
}

/** A model list of the Google connection: `unavailable` names models Google answered 404 for. */
function googleModels(models: string[], unavailable: string[] = []) {
  return {
    connectionId: "connection-1",
    kind: "google",
    models: models.map((remoteModel) => ({
      remoteModel,
      displayName: remoteModel,
      description: "",
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      methods: ["generateContent"],
    })),
    truncated: false,
    unavailable: unavailable.map((remoteModel) => ({
      remoteModel,
      markedAt: now,
    })),
    roles: (
      ["companion", "supervisor", "research", "reviewer", "media"] as const
    ).map((role) => ({
      role,
      needed: role === "companion" || role === "supervisor",
      method: "generateContent",
      videoMethod: role === "media" ? "predictLongRunning" : null,
      offered: true,
      suggested: role === "media" ? null : "gemini-3.8-flash",
    })),
    generationPerformed: false,
  };
}

/**
 * The pilot's case: the learner tutor and the lesson planner are on (gemini-3.8-flash, checked,
 * priced, with spending limits), and the owner saved a new tutor model (gemini-2.5-pro) that waits
 * for a quality check. With `notFound`, that check stopped on its first conversation because
 * Google answered 404 NOT_FOUND for the model, and the model list names it as unavailable.
 */
export async function stubDraftBesideOn(
  page: Page,
  options: {
    notFound?: boolean;
    /** The check stopped on this workspace's own setup instead (runtime UNKNOWN_MODEL or CAPABILITY_MISMATCH). */
    localFault?: "UNKNOWN_MODEL" | "CAPABILITY_MISMATCH";
  } = {},
) {
  const ws = "**/api/admin/workspaces/*";
  const active = {
    ...setup,
    revision: 3,
    configuration: {
      ...setup.configuration,
      registry: {
        revision: "x",
        models: onJobs.map((role) => ({
          id: `connection-1:${role}`,
          providerId: "connection-1",
          remoteModel: "gemini-3.8-flash",
        })),
      },
      roles: Object.fromEntries(
        onJobs.map((role) => [role, { modelId: `connection-1:${role}` }]),
      ),
    },
  };
  const waiting = {
    ...draft,
    baseRevision: 3,
    roles: onJobs.map((role) => ({
      role,
      modelId: `connection-1:${role}`,
      connectionId: "connection-1",
      remoteModel: role === "companion" ? "gemini-2.5-pro" : "gemini-3.8-flash",
      mediaKind: null,
      check: role === "companion" ? "needed" : "unchanged",
      priced: true,
      changed: role === "companion",
    })),
    waitingForCheck: ["companion"],
  };
  const notFoundCheck = {
    ...failedCheck,
    state: "error",
    reason: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
    reasonDetail: {
      role: "companion",
      providerCode: "NOT_FOUND",
      status: 404,
      providerReason: "NOT_FOUND",
    },
    roles: ["companion"],
    total: 9,
    completed: 1,
    chargedMicroUsd: 0,
    outcome: [],
  };
  const localFaultCheck = options.localFault && {
    ...notFoundCheck,
    reason:
      options.localFault === "UNKNOWN_MODEL"
        ? "PROVIDER_QUALITY_CHECK_MODEL_NOT_CONFIGURED"
        : "PROVIDER_QUALITY_CHECK_CAPABILITY_MISSING",
    reasonDetail: {
      role: "companion",
      providerCode: options.localFault,
      status: null,
      providerReason: null,
    },
  };
  const latest = localFaultCheck || (options.notFound ? notFoundCheck : null);
  const price = (role: string) => ({
    id: `00000000-0000-4000-8000-00000000010${role === "companion" ? 1 : 2}`,
    version: 1,
    status: "active",
    currency: "USD",
    inputMicroUsdPerMillionTokens: 750000,
    outputMicroUsdPerMillionTokens: 3750000,
    cachedInputMicroUsdPerMillionTokens: null,
    microUsdPerRequest: null,
    microUsdPerOutputSecond: null,
    effectiveFrom: now,
    sourceNote: "Synthetic test price",
    createdAt: now,
  });
  await page.route(`${ws}/provider-setup`, (route) =>
    route.fulfill({ json: active }),
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
            usedByRoles: [...onJobs],
          },
        ],
        serviceKeys: [],
        keyStorage: "encrypted_server_vault",
      },
    }),
  );
  await page.route(`${ws}/provider-setup/connections/*/models`, (route) =>
    route.fulfill({
      json: options.notFound
        ? googleModels(
            ["gemini-3.8-flash", "gemini-3.1-pro", "gemini-3.6-flash"],
            ["gemini-2.5-pro"],
          )
        : googleModels([
            "gemini-3.8-flash",
            "gemini-3.1-pro",
            "gemini-3.6-flash",
            "gemini-2.5-pro",
          ]),
    }),
  );
  await page.route(`${ws}/provider-setup/drafts/current`, (route) =>
    route.fulfill({ json: { draft: waiting } }),
  );
  await page.route(`${ws}/provider-pricing`, (route) =>
    route.fulfill({
      json: {
        requirePricing: true,
        settingsRevision: 0,
        currency: "USD",
        builtInPrices: false,
        models: onJobs.map((role) => ({
          modelId: `connection-1:${role}`,
          configured: true,
          roles: [role],
          inForce: price(role),
          latestVersion: 1,
          coverage: [{ role, priced: true }],
          history: [price(role)],
        })),
      },
    }),
  );
  await page.route(`${ws}/provider-setup/budgets`, (route) =>
    route.fulfill({
      json: {
        workspace: {
          revision: 1,
          limit_micro_usd: "25000000",
          limit_tokens: "0",
          used_micro_usd: "410000",
          used_tokens: "0",
        },
        defaultEnrollment: {
          revision: 1,
          mode: "limit",
          limit_micro_usd: "2000000",
          limit_tokens: "1000000000",
        },
        enrollments: [],
      },
    }),
  );
  await page.route(`${ws}/provider-evals`, (route) =>
    route.fulfill({
      json: {
        suite: {
          id: "core-public",
          version: "2",
          digest: "f".repeat(64),
          dialogues: 18,
          coverage: [{ role: "companion", dialogues: 9 }],
        },
        providerRevision: 3,
        gatedAtActivation: true,
        roles: onJobs.map((role, i) => ({
          role,
          strategy: `core.${role}`,
          revisionDigest: String(i).repeat(64),
          covered: true,
          status: "passed",
          grandfathered: false,
          activatedBy: "passed",
          evaluatedAt: approvedAt,
        })),
        results: [],
        overrides: [],
      },
    }),
  );
  await page.route(`${ws}/provider-setup/quality-check`, (route) =>
    route.fulfill({
      json: {
        target: "draft",
        draftId,
        roles: [
          {
            role: "companion",
            remoteModel: "gemini-2.5-pro",
            conversations: 9,
            priced: true,
            estimateMicroUsd: 54000,
          },
        ],
        conversations: 9,
        estimateMicroUsd: 54000,
        reserveMicroUsd: 900000,
        blocked: null,
        latest,
        activeRoles: [],
        onRoles: [],
        onAll: null,
      },
    }),
  );
  await page.route(`${ws}/provider-setup/quality-check/*`, (route) =>
    route.fulfill({ json: latest ?? notFoundCheck }),
  );
}
