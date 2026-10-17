import React from "react";
import { render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { CourseView } from "../src/views/CourseView";
import { useWorkspace } from "../src/hooks/useAdmin";
import { releaseSchema } from "../src/domain/contracts";
import { demo } from "./helpers";

const warning = { label: "Sandboxed web activities", passed: true, warning: true,
  detail: "A sandboxed web activity runtime is installed. Never put sensitive data in activity state or configuration." };

it("shows a standing activity-runtime warning as a warning, without blocking review", async () => {
  const client = demo();
  const { result } = renderHook(() => useWorkspace(client, "sorting"));
  await waitFor(() => expect(result.current.workspace).toBeDefined());
  const workspace = result.current.workspace!;
  const release = releaseSchema.parse({ ...workspace.releases[0]!, checks: [...workspace.releases[0]!.checks, warning] });
  render(<CourseView data={{ ...workspace, releases: [release, ...workspace.releases.slice(1)] }} client={client} actions={result.current} />);
  const item = screen.getByText("Sandboxed web activities").closest("li")!;
  expect(within(item).getByText("Warning")).toBeVisible();
  expect(within(item).getByText(/Never put sensitive data in activity state/)).toBeVisible();
  expect(within(item).queryByText("Recorded")).toBeNull();
});
