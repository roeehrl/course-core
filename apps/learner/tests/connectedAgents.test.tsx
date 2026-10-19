import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectedAgentsPanel } from "../src/components/ConnectedAgentsPanel.web";
import { CourseApiError } from "../src/client/apiClient";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
const base = `/api/enrollments/${enrollmentId}/agent-grants`;
const grant = (over: Record<string, unknown> = {}) => ({ id: "g1", label: "Desk assistant", scopes: ["context", "profile"], createdAt: "2026-10-14T10:00:00.000Z",
  expiresAt: "2026-10-21T10:00:00.000Z", revokedAt: null, revokedReason: null, lastUsedAt: null, state: "active", ...over });

describe("connected agents", () => {
  it("connects an agent with the chosen scopes and expiry, and shows the key once", async () => {
    let grants = [] as ReturnType<typeof grant>[];
    const request = vi.fn(async (url: string, method = "GET", body?: unknown) => {
      if (method === "POST") {
        expect(url).toBe(base);
        expect(body).toEqual({ label: "Desk assistant", scopes: ["context", "evidence", "history"], expiresInDays: 30 });
        grants = [grant({ scopes: ["context", "evidence", "history"] })];
        return { token: "ccat_" + "x".repeat(43), grant: grants[0] };
      }
      return { grants, recentCalls: [] };
    });
    render(<ConnectedAgentsPanel api={{ request } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
    expect(await screen.findByText("No agents are connected.")).toBeVisible();
    fireEvent.click(screen.getByText("Connect an agent"));
    const button = screen.getByRole("button", { name: "Connect agent" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name for this agent"), { target: { value: " Desk assistant " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Your stated preferences/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Your question history/ }));
    fireEvent.change(screen.getByLabelText("Disconnect automatically after"), { target: { value: "30" } });
    fireEvent.click(button);
    const key = await screen.findByLabelText("Access key");
    expect(key).toHaveValue("ccat_" + "x".repeat(43));
    expect(screen.getByText(/It is shown only once/)).toBeVisible();
    const list = await screen.findByRole("list", { name: "Agents connected now" });
    expect(within(list).getByText("Desk assistant")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "I saved it" }));
    expect(screen.queryByLabelText("Access key")).toBeNull();
  });

  it("disconnects an agent and lists it as earlier", async () => {
    let revoked = false;
    const request = vi.fn(async (url: string, method = "GET") => {
      if (method === "POST") { expect(url).toBe(`${base}/g1/revoke`); revoked = true; return { grant: grant({ state: "revoked" }) }; }
      return { grants: [grant(revoked ? { state: "revoked", revokedAt: "2026-10-15T10:00:00.000Z" } : {})], recentCalls: [] };
    });
    render(<ConnectedAgentsPanel api={{ request } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Desk assistant" }));
    expect(await screen.findByText("Earlier: Desk assistant (disconnected)")).toBeVisible();
    expect(screen.getByText("No agents are connected.")).toBeVisible();
  });

  it("explains the grant limit and an unavailable list", async () => {
    const request = vi.fn(async (_url: string, method = "GET") => {
      if (method === "POST") throw new CourseApiError("AGENT_GRANT_LIMIT", 409);
      return { grants: [], recentCalls: [] };
    });
    const { unmount } = render(<ConnectedAgentsPanel api={{ request } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
    fireEvent.click(await screen.findByText("Connect an agent"));
    fireEvent.change(screen.getByLabelText("Name for this agent"), { target: { value: "One more" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Disconnect one first/);
    unmount();
    render(<ConnectedAgentsPanel api={{ request: vi.fn(async () => { throw new Error("offline"); }) } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
    await waitFor(() => expect(screen.getByText("Your connected agents could not be loaded right now.")).toBeVisible());
  });
  it("copies the key where the clipboard exists, and selects it with a clear message where it does not (plain-http origin)", async () => {
    const token = "ccat_" + "y".repeat(43);
    const request = vi.fn(async (_url: string, method = "GET") =>
      method === "POST" ? { token, grant: grant() } : { grants: [], recentCalls: [] });
    const connect = async () => {
      fireEvent.click(await screen.findByText("Connect an agent"));
      fireEvent.change(screen.getByLabelText("Name for this agent"), { target: { value: "Desk assistant" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect agent" }));
      return screen.findByLabelText("Access key");
    };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { unmount } = render(<ConnectedAgentsPanel api={{ request } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(token);
    unmount();
    // A non-secure context has no navigator.clipboard at all.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      render(<ConnectedAgentsPanel api={{ request } as never} enrollmentId={enrollmentId} courseTitle="Ordering" />);
      const key = (await connect()) as HTMLInputElement;
      fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(/can.t copy for you on this connection/);
      expect(screen.getByRole("button", { name: "Copy key" })).toBeVisible();
      expect(document.activeElement).toBe(key);
      expect([key.selectionStart, key.selectionEnd]).toEqual([0, token.length]);
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
