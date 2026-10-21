import {
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CourseView } from "../src/views/CourseView";
import { useWorkspace } from "../src/hooks/useAdmin";
import { releaseSchema } from "../src/domain/contracts";
import { compareVersions, newerVersion } from "../src/domain/versions";
import { demo } from "./helpers";

describe("course version direction", () => {
  it("compares semantic versions like the server", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(compareVersions("1.0.0+build.1", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBeNull();
    expect(newerVersion("1.5.0", ["1.0.0", "2.0.0", "2.1.0", "legacy"])).toBe(
      "2.1.0",
    );
    expect(newerVersion("3.0.0", ["1.0.0", "2.1.0"])).toBeNull();
  });

  it("publishing an older version than one already published needs a second, explicit confirmation", async () => {
    const client = demo();
    const transitionRelease = vi.spyOn(client, "transitionRelease");
    const { result } = renderHook(() => useWorkspace(client, "sorting"));
    await waitFor(() => expect(result.current.workspace).toBeDefined());
    const workspace = result.current.workspace!;
    const base = workspace.releases[0]!;
    const older = releaseSchema.parse({
      ...base,
      id: "older",
      version: "1.5.0",
      state: "approved",
      availableForNewLearners: false,
    });
    const newer = releaseSchema.parse({
      ...base,
      id: "newer",
      version: "2.0.0",
      state: "published",
      availableForNewLearners: true,
    });
    render(
      <CourseView
        data={{ ...workspace, releases: [older, newer] }}
        client={client}
        actions={result.current}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Publish release" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Publish reviewed release",
    });
    expect(
      within(dialog).getByText(/Version 2\.0\.0 is already published/),
    ).toBeVisible();
    const confirm = within(dialog).getByRole("button", {
      name: "Confirm publication",
    });
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "I confirm publication of version 1.5.0.",
      }),
    );
    expect(confirm).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "I want to publish the older version 1.5.0",
      }),
    );
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(transitionRelease).toHaveBeenCalledWith(
        workspace.course.id,
        "older",
        "publish",
        expect.anything(),
        { confirmOlderVersion: true },
      ),
    );
  });
});
