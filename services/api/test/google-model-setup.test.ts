import { it, expect } from "vitest";
import { googleModelDraft } from "../src/google-model-setup.js";
import { composeProviders } from "../src/provider-composition.js";
import { configurationTokenBounds } from "../src/provider-setup.js";
import type { ModelCatalog } from "../src/provider-metadata.js";
const configuration = {
    registry: { revision: "draft", models: [] },
    adapters: [
      { id: "google", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
    ],
    roles: {},
  },
  catalog: ModelCatalog = {
    models: [
      {
        remoteModel: "public-text",
        displayName: "Public text",
        description: "Synthetic metadata",
        inputTokenLimit: 120000,
        outputTokenLimit: 4000,
        methods: ["generateContent"],
      },
      {
        remoteModel: "public-video",
        displayName: "Public video",
        description: "Synthetic metadata",
        inputTokenLimit: null,
        outputTokenLimit: null,
        methods: ["predictLongRunning"],
      },
    ],
    pages: 1,
    truncated: false,
    generationPerformed: false,
    capabilitiesVerified: false,
  };
it("prepares explicit role-specific capabilities and conservative bounds without a model call or budget approval", () => {
  const draft = googleModelDraft({
    configuration,
    adapterId: "google",
    catalog,
    assignments: {
      companion: "public-text",
      supervisor: "public-text",
      research: "public-text",
      media: {
        remoteModel: "public-video",
        kind: "video",
        durationSeconds: 4,
        aspectRatio: "16:9",
        resolution: "720p",
        downloadHosts: ["generativelanguage.googleapis.com"],
      },
    },
  });
  const runtime = composeProviders(draft, () => undefined);
  expect(runtime.describe()).toHaveLength(4);
  expect(runtime.status().companion.status).toBe("configuration_missing");
  expect(draft.roles.supervisor?.maxToolRounds).toBe(4);
  expect(draft.roles.supervisor?.maxInputCharacters).toBe(28976);
  expect(configurationTokenBounds(draft).supervisor).toBe(484000);
  expect(configuration.registry.models).toEqual([]);
});
it("rejects missing models, incompatible methods, unknown limits, too-small supervision context and undeclared video parameters", () => {
  for (const assignments of [
    { companion: "invented" },
    { companion: "public-video" },
    { media: { remoteModel: "public-video", kind: "video" as const } },
  ])
    expect(() =>
      googleModelDraft({
        configuration,
        adapterId: "google",
        catalog,
        assignments,
      }),
    ).toThrow();
  for (const limit of [null, 8192])
    expect(() =>
      googleModelDraft({
        configuration,
        adapterId: "google",
        catalog: {
          ...catalog,
          models: [{ ...catalog.models[0]!, inputTokenLimit: limit }],
        },
        assignments: { supervisor: "public-text" },
      }),
    ).toThrow();
});
it("gives Gemini thinking models a thinking setting per role and an output limit with room to think", () => {
  const models = (["gemini-3.8-flash", "gemini-2.5-flash", "gemini-3-pro-preview"] as const).map((remoteModel) => ({
    remoteModel, displayName: remoteModel, description: "Synthetic metadata", inputTokenLimit: 1048576, outputTokenLimit: 65536, methods: ["generateContent"],
  }));
  const draftFor = (remoteModel: string) => googleModelDraft({ configuration, adapterId: "google", catalog: { ...catalog, models },
    assignments: { companion: remoteModel, supervisor: remoteModel, reviewer: remoteModel } });
  const config = (draft: ReturnType<typeof googleModelDraft>, role: string) =>
    (draft.registry.models.find((m) => m.id === `google:${role}`) as { providerConfig: Record<string, unknown> }).providerConfig;
  const flash = draftFor("gemini-3.8-flash");
  expect(config(flash, "companion").thinking).toEqual({ level: "low" });
  expect(config(flash, "supervisor").thinking).toEqual({ level: "medium" });
  expect(flash.roles.companion).toMatchObject({ maxOutputTokens: 4096 });
  expect(flash.roles.supervisor).toMatchObject({ maxOutputTokens: 8192 });
  expect(flash.registry.models.find((m) => m.id === "google:companion")).toMatchObject({ limits: { maxOutputTokens: 4096 } });
  // Gemini 2.5 takes a budget, never a level.
  const legacy = draftFor("gemini-2.5-flash");
  expect(config(legacy, "companion").thinking).toEqual({ budget: 512 });
  expect(config(legacy, "reviewer").thinking).toEqual({ budget: -1 });
  // A level the model refuses (Gemini 3 Pro has no medium) is not sent: the model default applies.
  const pro = draftFor("gemini-3-pro-preview");
  expect(config(pro, "companion").thinking).toEqual({ level: "low" });
  expect(config(pro, "supervisor").thinking).toBeUndefined();
  expect(pro.roles.supervisor).toMatchObject({ maxOutputTokens: 8192 });
  // Not a thinking family: unchanged bounded default, no thinking setting.
  const plain = googleModelDraft({ configuration, adapterId: "google", catalog, assignments: { companion: "public-text" } });
  expect(config(plain, "companion").thinking).toBeUndefined();
  expect(plain.roles.companion).toMatchObject({ maxOutputTokens: 1000 });
  composeProviders(flash, () => "configured");
});
