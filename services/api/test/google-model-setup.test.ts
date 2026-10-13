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
