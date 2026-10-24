import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LearnerSpendPanel } from "../src/components/aiServices/LearnerSpendPanel";
import {
  createDemoLearnerSpend,
  demoLearnerSpendView,
} from "../src/client/demoLearnerSpend";
import { lastDays, learnerSpendSchema } from "../src/domain/learnerSpend";
import {
  I18nProvider,
  createAdminTranslator,
  type MessageKey,
} from "../src/i18n";

const english = createAdminTranslator("en"),
  hebrew = createAdminTranslator("he");
const t = (key: string, args?: Record<string, string | number>) =>
  english.t(`aiServices.${key}` as MessageKey, args);
const he = (key: string, args?: Record<string, string | number>) =>
  hebrew.t(`aiServices.${key}` as MessageKey, args);
const NOW = new Date("2026-03-10T12:00:00Z");
const demoView = (page = 1, pageSize = 10, days = 30) =>
  demoLearnerSpendView(
    { ...lastDays(days, NOW), page, pageSize },
    { now: () => NOW },
  );

describe("demo learner spending", () => {
  it("matches the server's contract and suggests a limit from the 90th percentile", () => {
    const view = learnerSpendSchema.parse(demoView());
    expect(view.learners).toBe(14);
    expect(view.learnerDays).toBeGreaterThanOrEqual(20);
    expect(view.recommendation.status).toBe("ready");
    if (view.recommendation.status !== "ready") return;
    // p90 of learner totals x 1.5, rounded up to $0.50.
    const expected =
      Math.ceil((view.distributions.learnerTotal.p90 * 1.5) / 500_000) *
      500_000;
    expect(view.recommendation.microUsd).toBe(expected);
    expect(view.distributions.learnerDay.p50).toBeLessThanOrEqual(
      view.distributions.learnerDay.p90,
    );
    // Highest spending first, by enrollment only.
    const totals = view.rows.map((r) => Number(r.charged));
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
    expect(JSON.stringify(view)).not.toMatch(/displayName|@/);
  });

  it("pages, and says there is not enough data in a short period", () => {
    expect(demoView(3, 5).rows).toHaveLength(4);
    const short = demoView(1, 10, 2);
    expect(short.recommendation).toMatchObject({
      status: "not_enough_data",
      minimumLearners: 5,
      minimumLearnerDays: 20,
    });
  });

  it("refuses when the demo scenario does", async () => {
    await expect(
      createDemoLearnerSpend({ scenario: "permission_denied" }).learnerSpend(
        "w",
        { ...lastDays(30), page: 1, pageSize: 10 },
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});

describe("learner spending panel", () => {
  it("loads when opened, shows the spread and pages through learners", async () => {
    const load = vi.fn((_: string, query: { page: number; pageSize: number }) =>
      Promise.resolve(
        demoLearnerSpendView(
          { ...query, ...lastDays(30, NOW), pageSize: 3 },
          { now: () => NOW },
        ),
      ),
    );
    render(<LearnerSpendPanel load={load} workspaceId="w" />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(t("learnerSpend.title")));
    expect(
      await screen.findByText(t("learnerSpend.rec.title")),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: t("learnerSpend.spreadCaption") }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        t("learnerSpend.pageStatus", { first: 1, last: 3, total: 14 }),
      ),
    ).toBeInTheDocument();
    // Read-only here: no button to apply the suggestion.
    expect(
      screen.queryByRole("button", { name: /Use .* as the limit/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: t("learnerSpend.previous") }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: t("learnerSpend.next") }),
    );
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        "w",
        expect.objectContaining({ page: 2 }),
        expect.anything(),
      ),
    );
    expect(
      await screen.findByText(
        t("learnerSpend.pageStatus", { first: 4, last: 6, total: 14 }),
      ),
    ).toBeInTheDocument();
  });

  it("says how much data is missing, and shows a failed load as unavailable", async () => {
    const short = demoLearnerSpendView(
      { ...lastDays(2, NOW), page: 1, pageSize: 10 },
      { now: () => NOW },
    );
    const load = vi
      .fn()
      .mockResolvedValueOnce(short)
      .mockRejectedValueOnce(new Error("down"));
    render(<LearnerSpendPanel load={load} workspaceId="w" onUse={vi.fn()} />);
    fireEvent.click(screen.getByText(t("learnerSpend.title")));
    expect(
      await screen.findByText(
        t("learnerSpend.rec.notEnough", {
          learners: short.learners,
          days: short.learnerDays,
          minLearners: 5,
          minDays: 20,
        }),
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("learnerSpend.period")), {
      target: { value: "7" },
    });
    expect(await screen.findByText(t("err.unavailable"))).toBeInTheDocument();
  });

  it("applies the suggestion with one click, unless it is already the limit", async () => {
    const view = demoView();
    const recommendation = view.recommendation;
    if (recommendation.status !== "ready") throw new Error("demo data");
    const onUse = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <LearnerSpendPanel
        load={() => Promise.resolve(view)}
        workspaceId="w"
        onUse={onUse}
        currentLimit={null}
      />,
    );
    fireEvent.click(screen.getByText(t("learnerSpend.title")));
    const amount = english.currency(recommendation.microUsd / 1e6, "USD", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: t("learnerSpend.rec.use", { amount }),
      }),
    );
    await waitFor(() =>
      expect(onUse).toHaveBeenCalledWith(recommendation.microUsd),
    );
    expect(
      await screen.findByText(t("learnerSpend.rec.saved", { amount })),
    ).toBeInTheDocument();
    unmount();
    render(
      <LearnerSpendPanel
        load={() => Promise.resolve(view)}
        workspaceId="w"
        onUse={onUse}
        currentLimit={recommendation.microUsd}
      />,
    );
    fireEvent.click(screen.getByText(t("learnerSpend.title")));
    expect(
      await screen.findByText(t("learnerSpend.rec.current")),
    ).toBeInTheDocument();
  });

  it("reads in Hebrew, right to left", async () => {
    render(
      <I18nProvider value={hebrew}>
        <div dir="rtl">
          <LearnerSpendPanel
            load={() => Promise.resolve(demoView())}
            workspaceId="w"
          />
        </div>
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText(he("learnerSpend.title")));
    expect(
      await screen.findByText(he("learnerSpend.rec.title")),
    ).toBeInTheDocument();
    expect(screen.getByText(he("learnerSpend.median"))).toBeInTheDocument();
  });
});
