import { describe, expect, it } from "vitest";
import {
  installTableCellLabels,
  labelTableCells,
} from "../src/client/tableLabels";

const table = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
};

describe("table cell labels for the phone card layout", () => {
  it("copies each column heading into its body cells, keeping explicit labels", () => {
    const host = table(`<table>
      <thead><tr><th>Person</th><th>Role</th><th colspan="2">Sign-in</th><th><span>Actions</span></th></tr></thead>
      <tbody><tr><th scope="row">Dana</th><td>Owner</td><td>Today</td><td>UTC</td><td data-label="">x</td></tr></tbody>
    </table>`);
    labelTableCells(host.querySelector("table")!);
    const cells = [...host.querySelectorAll("tbody tr > *")];
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual([
      null,
      "Role",
      "Sign-in",
      "Sign-in",
      "",
    ]);
    host.remove();
  });

  it("labels rows added later and follows a renamed heading", async () => {
    const host = table(`<table>
      <thead><tr><th>Name</th><th>Count</th></tr></thead><tbody></tbody>
    </table>`);
    const uninstall = installTableCellLabels(host);
    const body = host.querySelector("tbody")!;
    body.innerHTML = `<tr><td>a</td><td>1</td></tr>`;
    await Promise.resolve();
    await Promise.resolve();
    expect(
      body.querySelector("td:last-child")!.getAttribute("data-label"),
    ).toBe("Count");
    host.querySelector("thead th:last-child")!.textContent = "Total";
    await Promise.resolve();
    await Promise.resolve();
    expect(
      body.querySelector("td:last-child")!.getAttribute("data-label"),
    ).toBe("Total");
    uninstall();
    host.remove();
  });
});
