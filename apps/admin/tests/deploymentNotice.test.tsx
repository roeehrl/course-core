import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AdminApp } from "../src/AdminApp";
import { sessionSchema, type AdminSession } from "../src/domain/contracts";
import { demo } from "./helpers";

async function withDeployment(deployment: AdminSession["deployment"]) {
  const client = demo();
  const session = await client.getSession();
  return {
    ...client,
    getSession: async () => ({
      ...session,
      ...(deployment ? { deployment } : {}),
    }),
  };
}

describe("insecure-address deployment notice", () => {
  it("is shown, and cannot be dismissed, when the operator turned the check off", async () => {
    render(
      <AdminApp
        client={await withDeployment({ insecureOriginsAllowed: true })}
      />,
    );
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Insecure-address checks are off");
    expect(notice).toHaveTextContent(
      "Plain-http addresses outside Tailscale are trusted",
    );
    expect(notice).toHaveTextContent("is not encrypted");
    expect(within(notice).queryByRole("button")).not.toBeInTheDocument();
  });
  it.each([
    ["the check is on", { insecureOriginsAllowed: false }],
    ["an older server omits the flag", undefined],
  ])("is absent when %s", async (_, deployment) => {
    render(<AdminApp client={await withDeployment(deployment)} />);
    await screen.findByRole("heading", { level: 1 });
    expect(
      screen.queryByText("Insecure-address checks are off"),
    ).not.toBeInTheDocument();
  });
  it("parses sessions from older and newer servers", () => {
    const base = {
      actor: { id: "a", name: "Ada", role: "member" },
      courses: [],
    };
    expect(sessionSchema.parse(base).deployment).toBeUndefined();
    expect(sessionSchema.parse({ ...base, deployment: {} }).deployment).toEqual(
      { insecureOriginsAllowed: false },
    );
    expect(
      sessionSchema.parse({
        ...base,
        deployment: { insecureOriginsAllowed: true },
      }).deployment,
    ).toEqual({ insecureOriginsAllowed: true });
    expect(() =>
      sessionSchema.parse({
        ...base,
        deployment: { insecureOriginsAllowed: "yes" },
      }),
    ).toThrow();
  });
});
