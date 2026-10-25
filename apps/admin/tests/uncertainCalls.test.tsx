import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UncertainCallsPanel } from "../src/components/aiServices/UncertainCallsPanel";
import { AiServicesError, type AiServicesPort } from "../src/domain/aiServices";
import {
  uncertainCallsSchema,
  type UncertainCalls,
} from "../src/domain/providerCosts";
import {
  I18nProvider,
  createAdminTranslator,
  type MessageKey,
} from "../src/i18n";

// AI services / Spending: calls whose cost stayed unknown (live finding B-2) and the owner's
// explicit decision on each. A fake port stands in for the API (provider-spend-resolutions.ts).
const english = createAdminTranslator("en"),
  hebrew = createAdminTranslator("he");
const t = (key: string, args?: Record<string, string | number>) =>
  english.t(`aiServices.${key}` as MessageKey, args);
const PILOT = "00000000-0000-4000-8000-000000000b02",
  SETTLING = "00000000-0000-4000-8000-000000000b03";
/** A time as the panel shows it: UTC, to the second. */
const exactTime = (iso: string, translator = english) =>
  translator.dateTime(iso, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
function view(overrides: Partial<UncertainCalls> = {}): UncertainCalls {
  return uncertainCallsSchema.parse({
    currency: "USD",
    calls: [
      {
        id: PILOT,
        reservedAt: "2026-10-24T22:51:00.000Z",
        role: "companion",
        modelId: "gemini-3.8-flash",
        reservedMicroUsd: 31_410,
        enrollmentId: "00000000-0000-4000-8000-0000000000e1",
        happened: "no_response",
        settleable: true,
      },
      {
        id: SETTLING,
        reservedAt: "2026-10-25T08:00:00.000Z",
        role: "companion",
        modelId: "gemini-3.8-flash",
        reservedMicroUsd: 31_410,
        enrollmentId: "00000000-0000-4000-8000-0000000000e1",
        happened: "stopped",
        settleable: false,
      },
    ],
    more: false,
    uncertainCalls: 2,
    heldMicroUsd: 62_820,
    settleAfterMinutes: 10,
    recent: [],
    ...overrides,
  });
}
function port(
  initial: UncertainCalls,
  settle: AiServicesPort["settleUncertainCall"],
) {
  let current = initial;
  return {
    uncertainCalls: vi.fn(async () => current),
    settleUncertainCall: vi.fn(
      async (
        ...args: Parameters<NonNullable<AiServicesPort["settleUncertainCall"]>>
      ) => {
        const result = await settle!(...args);
        current = view({
          calls: initial.calls.filter((c) => c.id !== args[1]),
          uncertainCalls: 1,
          heldMicroUsd: 31_410,
          recent: [
            {
              ledgerId: args[1],
              decision: args[2].decision,
              reservedMicroUsd: 31_410,
              chargedMicroUsd: result.chargedMicroUsd,
              releasedMicroUsd: result.releasedMicroUsd,
              reason: args[2].reason,
              decidedAt: "2026-10-25T09:00:00.000Z",
              decidedBy: "Owner",
            },
          ],
        });
        return result;
      },
    ),
  } as unknown as AiServicesPort & {
    uncertainCalls: ReturnType<typeof vi.fn>;
    settleUncertainCall: ReturnType<typeof vi.fn>;
  };
}

describe("calls with an unknown cost", () => {
  it("explains each held call, settles one at $0 only after a choice and a note, and reloads the limits", async () => {
    const fake = port(view(), async (_w, ledgerId) => ({
      ledgerId,
      decision: "zero",
      chargedMicroUsd: 0,
      releasedMicroUsd: 31_410,
      settledAt: "2026-10-25T09:00:00.000Z",
    }));
    const onSettled = vi.fn();
    render(
      <UncertainCallsPanel port={fake} workspaceId="w" onSettled={onSettled} />,
    );
    expect(
      await screen.findByRole("heading", { name: t("unknown.title") }),
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: t("unknown.listLabel") });
    const [pilot, settling] = within(list).getAllByRole("listitem");
    expect(
      within(pilot!).getByText(t("unknown.happened.noResponse")),
    ).toBeTruthy();
    expect(within(pilot!).getByText("$0.03141")).toBeTruthy();
    // One that a receipt may still settle cannot be decided yet.
    expect(
      within(settling!).getByText(t("unknown.notYet", { minutes: 10 })),
    ).toBeTruthy();
    expect(within(settling!).queryByRole("button")).toBeNull();
    fireEvent.click(
      within(pilot!).getByRole("button", { name: t("unknown.decide") }),
    );
    // Nothing is sent without a choice and a note of what was checked.
    fireEvent.click(
      within(pilot!).getByRole("button", { name: t("unknown.save") }),
    );
    expect(within(pilot!).getByText(t("unknown.errDecision"))).toBeTruthy();
    expect(within(pilot!).getByText(t("unknown.errReason"))).toBeTruthy();
    expect(fake.settleUncertainCall).not.toHaveBeenCalled();
    fireEvent.click(
      within(pilot!).getByRole("radio", {
        name: t("unknown.zero", { amount: "$0.03141", zero: "$0.00" }),
      }),
    );
    fireEvent.change(
      within(pilot!).getByRole("textbox", { name: t("unknown.reason") }),
      { target: { value: "  Usage page shows no request then  " } },
    );
    fireEvent.click(
      within(pilot!).getByRole("button", { name: t("unknown.save") }),
    );
    await waitFor(() =>
      expect(fake.settleUncertainCall).toHaveBeenCalledTimes(1),
    );
    expect(fake.settleUncertainCall.mock.calls[0]!.slice(0, 2)).toEqual([
      "w",
      PILOT,
    ]);
    expect(fake.settleUncertainCall.mock.calls[0]![2]).toMatchObject({
      decision: "zero",
      expectedReservedMicroUsd: 31_410,
      reason: "Usage page shows no request then",
    });
    expect(fake.settleUncertainCall.mock.calls[0]![2].idempotencyKey).toMatch(
      /^ai-services:/,
    );
    // The message names the call that was decided.
    expect(
      await screen.findByText(
        t("unknown.savedZero", {
          job: english.t("aiServices.role.companion.name" as MessageKey),
          when: exactTime("2026-10-24T22:51:00.000Z"),
          ref: t("unknown.ref", { id: "00000b02" }),
          amount: "$0.03141",
          zero: "$0.00",
        }),
      ),
    ).toBeTruthy();
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(
      within(
        screen.getByRole("list", { name: t("unknown.listLabel") }),
      ).getAllByRole("listitem"),
    ).toHaveLength(1);
    expect(screen.getByText(t("unknown.recent"))).toBeTruthy();
  });

  it("says when a call is still settling or was already decided, and keeps the form for a lost answer", async () => {
    let attempt = 0;
    const fake = port(view(), async () => {
      attempt += 1;
      throw new AiServicesError(
        attempt === 1 ? "UNAVAILABLE" : "PROVIDER_SPEND_ALREADY_SETTLED",
        attempt === 1 ? 0 : 409,
      );
    });
    render(<UncertainCallsPanel port={fake} workspaceId="w" />);
    const list = await screen.findByRole("list", {
      name: t("unknown.listLabel"),
    });
    const pilot = within(list).getAllByRole("listitem")[0]!;
    fireEvent.click(
      within(pilot).getByRole("button", { name: t("unknown.decide") }),
    );
    fireEvent.click(
      within(pilot).getByRole("radio", {
        name: t("unknown.keep", { amount: "$0.03141" }),
      }),
    );
    fireEvent.change(
      within(pilot).getByRole("textbox", { name: t("unknown.reason") }),
      { target: { value: "Billed in console" } },
    );
    fireEvent.click(
      within(pilot).getByRole("button", { name: t("unknown.save") }),
    );
    expect(await screen.findByText(t("err.unavailable"))).toBeTruthy();
    // The same request (same key) is sent again after a lost answer.
    fireEvent.click(
      within(pilot).getByRole("button", { name: t("unknown.save") }),
    );
    expect(await screen.findByText(t("unknown.errChanged"))).toBeTruthy();
    const keys = fake.settleUncertainCall.mock.calls.map(
      (c) => c[2].idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows nothing when there is nothing to decide, and reads in Hebrew right to left", async () => {
    const empty = port(
      view({ calls: [], uncertainCalls: 0, heldMicroUsd: 0 }),
      async () => {
        throw new Error("unused");
      },
    );
    const { container, unmount } = render(
      <UncertainCallsPanel port={empty} workspaceId="w" />,
    );
    await waitFor(() => expect(empty.uncertainCalls).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    unmount();
    const fake = port(view(), async () => {
      throw new Error("unused");
    });
    render(
      <I18nProvider value={hebrew}>
        <div dir="rtl">
          <UncertainCallsPanel port={fake} workspaceId="w" />
        </div>
      </I18nProvider>,
    );
    expect(
      await screen.findByRole("heading", {
        name: hebrew.t("aiServices.unknown.title"),
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(hebrew.t("aiServices.unknown.happened.noResponse")),
    ).toBeTruthy();
  });

  it("tells apart calls sent in the same minute, by the second and a short reference", async () => {
    const twin = "00000000-0000-4000-8000-0000000c4a17";
    const fake = port(
      view({
        calls: [
          { ...view().calls[0]!, reservedAt: "2026-10-25T07:45:12.000Z" },
          {
            ...view().calls[0]!,
            id: twin,
            reservedAt: "2026-10-25T07:45:41.000Z",
          },
        ],
      }),
      async () => {
        throw new Error("unused");
      },
    );
    render(<UncertainCallsPanel port={fake} workspaceId="w" />);
    const list = await screen.findByRole("list", {
      name: t("unknown.listLabel"),
    });
    const heads = within(list)
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".ai-unknown-head")!.textContent);
    expect(heads).toEqual([
      `Learner tutor · ${exactTime("2026-10-25T07:45:12.000Z")} · ref. 00000b02`,
      `Learner tutor · ${exactTime("2026-10-25T07:45:41.000Z")} · ref. 000c4a17`,
    ]);
    expect(heads[0]).toMatch(/7:45:12/);
    expect(new Set(heads).size).toBe(2);
  });

  it("in Hebrew, keeps a date and an English note in their own order, and names each decided call", async () => {
    const fake = port(
      view({
        recent: [
          {
            ledgerId: PILOT,
            decision: "zero",
            reservedMicroUsd: 31_410,
            chargedMicroUsd: 0,
            releasedMicroUsd: 31_410,
            reason: "Checked the provider usage page: no request at that time.",
            decidedAt: "2026-10-25T07:51:00.000Z",
            decidedBy: "Owner up",
            role: "companion",
            reservedAt: "2026-10-24T22:51:00.000Z",
          },
        ],
      }),
      async () => {
        throw new Error("unused");
      },
    );
    const { container } = render(
      <I18nProvider value={hebrew}>
        <div dir="rtl">
          <UncertainCallsPanel port={fake} workspaceId="w" />
        </div>
      </I18nProvider>,
    );
    await screen.findByRole("list", {
      name: hebrew.t("aiServices.unknown.listLabel"),
    });
    // The call's time is isolated without forcing it left to right: a Hebrew date reads right
    // to left (it used to read "UTC באוק׳ 2026, 07:45 · 25").
    const times = Array.from(container.querySelectorAll(".ai-unknown-when"));
    expect(times.length).toBe(3);
    for (const time of times) {
      expect(time.tagName).toBe("BDI");
      expect(time.getAttribute("dir")).toBeNull();
      expect(time.closest('[dir="ltr"]')).toBeNull();
    }
    expect(times[0]!.textContent).toBe(
      exactTime("2026-10-24T22:51:00.000Z", hebrew),
    );
    // The note is its own isolated block in its own direction.
    const note = container.querySelector(".ai-unknown-recent q")!;
    expect(note.getAttribute("dir")).toBe("auto");
    expect(note.textContent).toBe(
      "Checked the provider usage page: no request at that time.",
    );
    const decided = container.querySelector(".ai-unknown-recent li")!;
    expect(decided.querySelector(".ai-unknown-head")!.textContent).toContain(
      hebrew.t("aiServices.role.companion.name" as MessageKey),
    );
    expect(decided.textContent).toContain("Owner up");
  });
});
