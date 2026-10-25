import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { RecoveryRegistry } from "../src/components/RecoveryRegistry";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { demoWorkspace, demoSession } from "../src/data/fixtures";
import { demo } from "./helpers";
import type { AdminClient } from "../src/domain/contracts";
import { I18nProvider, createAdminTranslator } from "../src/i18n";
const workspace = () => ({
  ...demoWorkspace(demoSession("administrator").courses[0]!, "administrator"),
  role: "owner",
});
it("connected recovery approval shows exact installed code and revision and preserves a failed draft", async () => {
  const approve = vi
    .fn()
    .mockRejectedValueOnce(new Error("PRIVATE_FAILURE_CANARY"))
    .mockResolvedValueOnce({ registryRevision: 2 });
  const client: AdminClient = {
    ...demo(),
    mode: "connected",
    adaptationRuntime: vi.fn().mockResolvedValue({
      adapters: [
        {
          id: "bounded-numeric-v1",
          kind: "numeric",
          implementationDigest: "a".repeat(64),
          authorization: "release_registry_approval_required",
        },
      ],
    }),
    adaptationRegistry: vi.fn().mockResolvedValue({
      registryRevision: 1,
      configured: true,
      configurationDigest: null,
    }),
    approveAdaptationRegistry: approve,
  };
  render(<RecoveryRegistry data={workspace()} client={client} />);
  await screen.findByText("Registry revision 1 · approved");
  const editor = screen.getByRole("textbox", {
    name: "Recovery registry configuration",
  });
  fireEvent.change(editor, { target: { value: '{"profiles":[]}' } });
  const button = screen.getByRole("button", {
    name: "Approve recovery registry",
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText(/Approval could not be confirmed/);
  expect(editor).toHaveValue('{"profiles":[]}');
  expect(screen.queryByText("PRIVATE_FAILURE_CANARY")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh recovery registry" }),
  );
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText(/Registry approved for this immutable release/);
  expect(approve).toHaveBeenLastCalledWith(workspace().releases[0]!.id, 1, {
    profiles: [],
  });
});
it("demo and unauthorized roles cannot submit recovery approvals", () => {
  render(<RecoveryRegistry data={workspace()} client={demo()} />);
  expect(screen.getByText(/A connected owner or administrator/)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Approve recovery registry" }),
  ).toBeNull();
});
it("fetch client uses protected release routes and sends the registry revision without owner or proof claims", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ registryRevision: 2 }));
  const client = createFetchAdminClient({
    baseUrl: "/api/admin",
    fetch: fetcher,
    requestHeaders: () => ({ "x-csrf-token": "test-csrf" }),
  });
  await client.approveAdaptationRegistry!("release", 1, { profiles: [] });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("/api/admin/releases/release/adaptation-registry");
  expect(options!.credentials).toBe("include");
  expect(JSON.parse(String(options!.body))).toEqual({
    expectedRegistryRevision: 1,
    configuration: { profiles: [] },
  });
});

it("names each release's state in the reader's language, never the raw code", async () => {
  const client: AdminClient = {
    ...demo(),
    mode: "connected",
    adaptationRuntime: vi.fn().mockResolvedValue({ adapters: [] }),
    adaptationRegistry: vi.fn().mockResolvedValue({
      registryRevision: 1,
      configured: false,
      configurationDigest: null,
    }),
    approveAdaptationRegistry: vi.fn(),
  };
  const data = workspace();
  const versions = data.releases.map((r) => r.version);
  for (const [locale, published] of [
    ["en", "published"],
    ["he", "פורסם"],
  ] as const) {
    const { unmount } = render(
      <I18nProvider value={createAdminTranslator(locale)}>
        <RecoveryRegistry data={data} client={client} />
      </I18nProvider>,
    );
    const options = within(screen.getByRole("combobox"))
      .getAllByRole("option")
      .map((o) => o.textContent!.replace(/[\u2066-\u2069]/g, ""));
    expect(options).toHaveLength(versions.length);
    const index = data.releases.findIndex((r) => r.state === "published");
    expect(options[index]).toBe(`${versions[index]} · ${published}`);
    // No option shows a raw state code.
    for (const option of options)
      expect(option).not.toMatch(/pending_review|\bpublished\b.*_/);
    if (locale === "he")
      for (const option of options) expect(option).not.toMatch(/[a-z]{4,}/);
    unmount();
  }
  // The pseudo-locale translates the state too.
  render(
    <I18nProvider value={createAdminTranslator("en-XA")}>
      <RecoveryRegistry data={data} client={client} />
    </I18nProvider>,
  );
  const pseudo = within(screen.getByRole("combobox"))
    .getAllByRole("option")
    .map((o) => o.textContent!);
  for (const option of pseudo) expect(option).not.toMatch(/· published$/);
});
