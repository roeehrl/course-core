import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminApp } from "../src/AdminApp";
import { PolicyView } from "../src/views/PolicyView";
import { useWorkspace } from "../src/hooks/useAdmin";
import { ErrorState } from "../src/components/ui";
import { AdminError } from "../src/domain/errors";
import { demo } from "./helpers";
import type {
  AdminClient,
  AdminSession,
  ExtensionPreview,
} from "../src/domain/contracts";

describe("admin presentation workflows", () => {
  it("renders loading and recovers from a failed session load", async () => {
    let reject!: (error: Error) => void;
    const client = demo();
    const session = await client.getSession();
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AdminSession>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(session);
    render(<AdminApp client={{ ...client, getSession: load }} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Opening administration",
    );
    await act(async () => reject(new Error("private server detail")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "service is unavailable",
    );
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh and try again" }),
    );
    await screen.findByRole("heading", {
      name: /A clear path/,
    });
  });
  it("presents observer restrictions without pretending they provide server authorization", async () => {
    render(<AdminApp client={demo({ role: "observer" })} />);
    expect(
      await screen.findByRole("button", { name: "Edit course details" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "New draft" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Run inspector" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
    expect(
      screen.getByText("Server authorization governs every action."),
    ).toBeVisible();
  });
  it("keeps release publication gated through the review state", async () => {
    render(<AdminApp client={demo()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Submit for review" }),
    );
    expect(
      await screen.findByRole("button", { name: "Publish after approval" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Approve review" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Publish release" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Publish reviewed release",
    });
    expect(
      within(dialog).getByRole("button", { name: "Confirm publication" }),
    ).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Confirm publication" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText("Demo release marked published. Nothing was deployed."),
    ).toBeVisible();
  });
  it("isolates per-course selection and renders genuine empty search states", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("button", { name: "New draft" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Course" }),
      "graphs",
    );
    await screen.findByText(
      "A public example course about nodes, edges and finding a path.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Enrollments" }));
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Find a learner" }),
      "does-not-exist",
    );
    expect(
      screen.getByRole("heading", { name: "No matching learners" }),
    ).toBeVisible();
  });
  it("shows both clocks, inherited caps and bounded/open-ended modes", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("button", { name: "New draft" });
    await userEvent.click(
      screen.getByRole("button", { name: "Policy & extensions" }),
    );
    await screen.findByText("14 calendar days from scope started");
    expect(
      screen.getByRole("table", {
        name: "Inherited work caps and current usage",
      }),
    ).toHaveTextContent("240");
    expect(screen.getByText("Maximum days per grant")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: /Chapter · Open exploration/ }),
    );
    expect(screen.getByText("open-ended mode")).toBeVisible();
    expect(
      screen.getByText(
        /Applicable ancestor deadlines and work caps still bind/,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Preview calendar extension" }),
    ).toBeDisabled();
  });
  it("clears exact preview and staff review when calendar days change", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("button", { name: "New draft" });
    await userEvent.click(
      screen.getByRole("button", { name: "Policy & extensions" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Preview calendar extension" }),
    );
    const review = await screen.findByRole("checkbox", {
      name: /I reviewed these exact terms/,
    });
    await userEvent.click(review);
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Additional calendar days" }),
      { target: { value: "3" } },
    );
    expect(
      screen.queryByRole("checkbox", { name: /I reviewed these exact terms/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Preview calendar extension" }),
    );
    expect(
      await screen.findByRole("checkbox", {
        name: /I reviewed these exact terms/,
      }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("button", {
        name: /accept|grant|authorize reservation/i,
      }),
    ).not.toBeInTheDocument();
  });
  it("discards an obsolete calendar preview response", async () => {
    const client = demo();
    let resolve!: (value: ExtensionPreview) => void;
    const preview = await client.previewExtension("sorting-learner-01", {
      scopeId: "chapter:foundations",
      days: 2,
    });
    const delayed: AdminClient = {
      ...client,
      previewExtension: vi.fn(
        () =>
          new Promise<ExtensionPreview>((done) => {
            resolve = done;
          }),
      ),
    };
    render(<AdminApp client={delayed} />);
    await screen.findByRole("button", { name: "New draft" });
    await userEvent.click(
      screen.getByRole("button", { name: "Policy & extensions" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Preview calendar extension" }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Additional calendar days" }),
      { target: { value: "3" } },
    );
    await act(async () => resolve(preview));
    expect(
      screen.queryByRole("heading", { name: "Resolved extension terms" }),
    ).not.toBeInTheDocument();
  });
  it("shows configuration absent and never offers a fake provider test", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("button", { name: "New draft" });
    await userEvent.click(screen.getByRole("button", { name: "Providers" }));
    expect(screen.getAllByText("absent")).toHaveLength(2);
    expect(screen.getAllByText("Not verified")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /test connection/i }),
    ).not.toBeInTheDocument();
  });
  it.each([
    "permission_denied",
    "stale_revision",
    "pending_review",
    "config_absent",
  ] as const)("has an actionable %s error state", (code) => {
    render(<ErrorState error={new AdminError(code)} />);
    expect(screen.getByRole("alert").textContent!.length).toBeGreaterThan(40);
  });
});
