import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DraftEditor, MAX_MANIFEST_FILE_BYTES, readManifestFile } from "../src/components/DraftEditor";
import type { AdminClient } from "../src/domain/contracts";
import type { WorkspaceActions } from "../src/hooks/useAdmin";

// Synthetic manifests only: the shape matters here, not any course's content.
const current = { schemaVersion: "1", id: "synthetic-course", version: "1.1.0", summary: "Current draft." };
const chosen = { schemaVersion: "1", id: "synthetic-course", version: "1.1.0", summary: "Loaded from a file." };
const file = (text: string, name = "course.manifest.json") => new File([text], name, { type: "application/json" });

function setup(editable = true) {
  const updateRelease = vi.fn(async () => ({}));
  const client = {
    getReleaseManifest: vi.fn(async () => ({ manifest: current, notes: "Notes.", editable })),
    updateRelease,
  } as unknown as AdminClient;
  const run = vi.fn(async (_key: string, action: (context: unknown) => Promise<unknown>) => action({ expectedRevision: "1", idempotencyKey: "k" }));
  const actions = { pending: false, error: undefined, receipt: undefined, run, refresh: vi.fn() } as unknown as WorkspaceActions;
  const onClose = vi.fn();
  render(<DraftEditor client={client} courseId="c1" releaseId="r1" actions={actions} onClose={onClose} />);
  return { updateRelease, onClose };
}

describe("loading a draft bundle from a file", () => {
  it("loads a manifest file into the bundle text and saves it through the same draft path", async () => {
    const { updateRelease, onClose } = setup();
    const input = await screen.findByLabelText("Load from file…");
    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAttribute("accept", ".json,application/json");
    expect(input).toHaveAccessibleDescription(/Choose course\.manifest\.json/);
    await userEvent.upload(input, file(JSON.stringify(chosen)));
    expect(await screen.findByText(/Loaded course\.manifest\.json \(0\.0 MB\) into the bundle below/)).toBeVisible();
    expect(JSON.parse((screen.getByLabelText("Course bundle JSON") as HTMLTextAreaElement).value)).toEqual(chosen);
    // Loading does not save on its own.
    expect(updateRelease).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Validate and save draft" }));
    await waitFor(() => expect(updateRelease).toHaveBeenCalledWith("c1", "r1", { manifest: chosen, notes: "Notes." }, expect.anything()));
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses a file that is not JSON and keeps the current text", async () => {
    const { updateRelease } = setup();
    const input = await screen.findByLabelText("Load from file…");
    await userEvent.upload(input, file("{ not json", "notes.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent("notes.json is not valid JSON. Choose the course's course.manifest.json.");
    expect(JSON.parse((screen.getByLabelText("Course bundle JSON") as HTMLTextAreaElement).value)).toEqual(current);
    expect(updateRelease).not.toHaveBeenCalled();
  });

  it("refuses a compiled bundle wrapper and points to course.manifest.json", async () => {
    setup();
    const input = await screen.findByLabelText("Load from file…");
    await userEvent.upload(input, file(JSON.stringify({ formatVersion: 1, server: chosen, client: {} }), "course.bundle.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/course\.bundle\.json is a compiled course bundle, not a course manifest\. Choose course\.manifest\.json/);
    expect(JSON.parse((screen.getByLabelText("Course bundle JSON") as HTMLTextAreaElement).value)).toEqual(current);
  });

  it("clears an earlier file error once a valid manifest loads", async () => {
    setup();
    const input = await screen.findByLabelText("Load from file…");
    await userEvent.upload(input, file("[1,2]", "list.json"));
    expect(await screen.findByRole("alert")).toHaveTextContent("list.json is not a course manifest");
    await userEvent.upload(input, file(JSON.stringify(chosen)));
    await screen.findByText(/Loaded course\.manifest\.json/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is disabled for a release that is not editable", async () => {
    setup(false);
    expect(await screen.findByLabelText("Load from file…")).toBeDisabled();
  });

  it("refuses a file larger than the draft route accepts without reading it", async () => {
    const big = { name: "course.manifest.json", size: MAX_MANIFEST_FILE_BYTES + 1, text: vi.fn() } as unknown as File;
    expect(await readManifestFile(big)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 16\.0 MB/) });
    expect(big.text).not.toHaveBeenCalled();
  });

  it("accepts a manifest whose own fields mention formatVersion or server separately", async () => {
    expect(await readManifestFile(file(JSON.stringify({ ...chosen, server: { note: "a manifest field" } })))).toMatchObject({ ok: true });
    expect(await readManifestFile(file(JSON.stringify({ ...chosen, formatVersion: 2 })))).toMatchObject({ ok: true });
  });
});
