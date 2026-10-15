import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { ProviderModelGuide } from "../src/components/ProviderModelGuide";
import type {
  ProviderSetup,
  ProviderSetupPort,
} from "../src/domain/providerSetup";
const setup: ProviderSetup = {
  revision: 1,
  configuration: {
    registry: { revision: "empty", models: [] },
    adapters: [
      { id: "google", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
    ],
    roles: {},
  },
  jobPolicy: {
    allowance: { microUsd: 100000, tokens: 10000 },
    durationMs: 300000,
    timeoutMs: 60000,
    maxAttempts: 3,
  },
  tokenBounds: {},
  credentials: [],
  models: [],
  roles: {},
  verification: "not_run",
  storage: "encrypted_server_vault",
  budgetIsSeparate: true,
  metadataKinds: [{ kind: "google", label: "Google", guided: true }],
};
function api() {
  return {
    inspectModels: vi.fn().mockResolvedValue({
      id: "inspection",
      state: "complete",
      reason: null,
      result: {
        models: [
          {
            remoteModel: "public-model",
            displayName: "Public model",
            description: "Metadata only",
            inputTokenLimit: 120000,
            outputTokenLimit: 4000,
            methods: ["generateContent"],
          },
        ],
        pages: 1,
        truncated: false,
        generationPerformed: false,
        capabilitiesVerified: false,
      },
    }),
    previewModels: vi.fn().mockResolvedValue({
      configuration: { roles: { supervisor: { modelId: "draft" } } },
      tokenBounds: { supervisor: 500384 },
      minimumTokens: 500384,
      paidBudgetChanged: false,
      capabilitiesVerified: false,
      generationPerformed: false,
    }),
  } as unknown as ProviderSetupPort;
}
it("does not inspect or draft automatically; requires explicit declarations and a separate use-draft action", async () => {
  const port = api(),
    onDraft = vi.fn();
  render(
    <ProviderModelGuide
      workspaceId="one"
      setup={setup}
      api={port}
      disabled={false}
      onConnection={() => {}}
      onDraft={onDraft}
    />,
  );
  expect(port.inspectModels).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect model metadata" }),
  );
  await screen.findByText(/Inspected 1 models/);
  fireEvent.change(screen.getByLabelText("supervisor model"), {
    target: { value: "public-model" },
  });
  expect(
    screen.getByRole("button", { name: "Review model configuration" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I declare these roles and parameters; metadata inspection is not live verification.",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Review model configuration" }),
  );
  await screen.findByText(/Required conservative reservation: 500,384/);
  expect(onDraft).not.toHaveBeenCalled();
  expect(port.previewModels).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({
      expectedRevision: 1,
      assignments: { supervisor: "public-model" },
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Use draft and reserve 500,384 tokens",
    }),
  );
  expect(onDraft).toHaveBeenCalledTimes(1);
});
it("lost metadata acknowledgement retries the original request identity rather than creating another inspection", async () => {
  const port = api();
  vi.mocked(port.inspectModels!).mockRejectedValueOnce(Error("lost response"));
  render(
    <ProviderModelGuide
      workspaceId="one"
      setup={setup}
      api={port}
      disabled={false}
      onConnection={() => {}}
      onDraft={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect model metadata" }),
  );
  await screen.findByText(/Inspection is unconfirmed/);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry metadata inspection" }),
  );
  await screen.findByText(/Inspected 1 models/);
  const calls = vi.mocked(port.inspectModels!).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
});
it("changing connection resets visible role choices and stale declarations", async () => {
  const port = api();
  render(
    <ProviderModelGuide
      workspaceId="one"
      setup={{
        ...setup,
        configuration: {
          ...(setup.configuration as object),
          adapters: [
            { id: "google", kind: "google" },
            { id: "second", kind: "google" },
          ],
        },
      }}
      api={port}
      disabled={false}
      onConnection={() => {}}
      onDraft={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect model metadata" }),
  );
  await screen.findByText(/Inspected 1 models/);
  fireEvent.change(screen.getByLabelText("supervisor model"), {
    target: { value: "public-model" },
  });
  fireEvent.change(screen.getByLabelText("Connection to inspect"), {
    target: { value: "second" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Inspect model metadata" }),
  );
  await screen.findByText(/Inspected 1 models/);
  expect(screen.getByLabelText("supervisor model")).toHaveValue("keep");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});
it("an Anthropic connection lists models by the method each text role needs and never offers media", async () => {
  const port = api();
  vi.mocked(port.inspectModels!).mockResolvedValueOnce({
    id: "inspection",
    state: "complete",
    reason: null,
    result: {
      models: [
        { remoteModel: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: "", inputTokenLimit: 1000000, outputTokenLimit: 128000,
          methods: ["messages", "structured_outputs", "web_search", "effort_low", "thinking_disabled"] },
        { remoteModel: "claude-plain", displayName: "Plain", description: "", inputTokenLimit: 200000, outputTokenLimit: 8000, methods: ["messages"] },
      ],
      pages: 1,
      truncated: false,
      generationPerformed: false,
      capabilitiesVerified: false,
    },
  } as never);
  render(
    <ProviderModelGuide
      workspaceId="one"
      setup={{
        ...setup,
        configuration: { ...(setup.configuration as object), adapters: [{ id: "claude", kind: "anthropic", credentialEnv: "COURSE_PROVIDER_CLAUDE_API_KEY" }] },
        metadataKinds: [
          { kind: "google", label: "Google", guided: true },
          { kind: "anthropic", label: "Anthropic", guided: true, roleMethods: { companion: "messages", supervisor: "structured_outputs",
            research: "web_search", reviewer: "structured_outputs", media: null } },
        ],
      }}
      api={port}
      disabled={false}
      onConnection={() => {}}
      onDraft={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect model metadata" }));
  await screen.findByText(/Inspected 2 models/);
  const options = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map((o) => o.value);
  expect(options("companion model")).toEqual(["keep", "disable", "claude-haiku-5-5", "claude-plain"]);
  expect(options("supervisor model")).toEqual(["keep", "disable", "claude-haiku-5-5"]);
  expect(options("research model")).toEqual(["keep", "disable", "claude-haiku-5-5"]);
  expect(screen.queryByLabelText("media model")).toBeNull();
  expect(screen.queryByLabelText("Media output kind")).toBeNull();
  screen.getByText("Anthropic offers no image or video generation. The media role keeps its current connection.");
  fireEvent.change(screen.getByLabelText("companion model"), { target: { value: "claude-plain" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "I declare these roles and parameters; metadata inspection is not live verification." }));
  fireEvent.click(screen.getByRole("button", { name: "Review model configuration" }));
  await waitFor(() => expect(port.previewModels).toHaveBeenCalled());
  // Media is never sent as an assignment for a provider without media.
  expect(vi.mocked(port.previewModels!).mock.calls[0]![1]).toMatchObject({ assignments: { companion: "claude-plain" } });
  expect(Object.keys((vi.mocked(port.previewModels!).mock.calls[0]![1] as { assignments: object }).assignments)).toEqual(["companion"]);
});
