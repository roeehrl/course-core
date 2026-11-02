import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { CheckDetails } from "../src/components/aiServices/CheckDetails";
import type { AiServicesPort, QualityCheck } from "../src/domain/aiServices";
import enAi from "../src/i18n/messages/en/aiServices.json";

// "Details of each conversation" loads once when opened, however often the page around it
// re-renders. The port is a fake: nothing here contacts a server.
const workspace = "00000000-0000-4000-8000-000000000001";
const checkId = "00000000-0000-4000-8000-0000000000c9";
const finished = { id: checkId, state: "failed" } as QualityCheck;

/** A page that re-renders on demand, as the AI services page does while it polls. */
function Page({ port }: { port: AiServicesPort }) {
  const [renders, setRenders] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setRenders(renders + 1)}>
        rerender {renders}
      </button>
      <CheckDetails
        check={finished}
        source={{ port, workspaceId: workspace }}
      />
    </>
  );
}
const rerender = () =>
  fireEvent.click(screen.getByRole("button", { name: /rerender/ }));
const open = () => {
  const details = screen
    .getByText(enAi["check.details.title"])
    .closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
};

describe("check details", () => {
  it("asks for a check's details once while the page re-renders", async () => {
    let finish: (value: unknown) => void = () => {};
    const qualityCheckDetails = vi.fn(
      (_workspace: string, _check: string, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const port = { qualityCheckDetails } as unknown as AiServicesPort;
    render(<Page port={port} />);
    act(open);
    expect(qualityCheckDetails).toHaveBeenCalledTimes(1);
    const signal = qualityCheckDetails.mock.calls[0]![2]!;
    act(rerender);
    act(rerender);
    expect(qualityCheckDetails).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () =>
      finish({ checkId, state: "failed", recorded: false, roles: [] }),
    );
    act(rerender);
    expect(qualityCheckDetails).toHaveBeenCalledTimes(1);
  });

  it("after a failure, asks again only when Try again is pressed", async () => {
    const qualityCheckDetails = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        checkId,
        state: "failed",
        recorded: false,
        roles: [],
      });
    const port = { qualityCheckDetails } as unknown as AiServicesPort;
    render(<Page port={port} />);
    act(open);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    act(rerender);
    act(rerender);
    expect(qualityCheckDetails).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: enAi["check.details.retry"] }),
    );
    expect(qualityCheckDetails).toHaveBeenCalledTimes(2);
  });
});
