import { useState, type ChangeEvent } from "react";
import type { AdminClient } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { useRemote } from "../hooks/useAdmin";
import { ActionFeedback } from "./ActionFeedback";
import { Button, Dialog, ErrorState, Field, Loading, Notice } from "./ui";

export function DraftEditor({
  client,
  courseId,
  releaseId,
  actions,
  onClose,
}: {
  client: AdminClient;
  courseId: string;
  releaseId: string;
  actions: WorkspaceActions;
  onClose: () => void;
}) {
  const remote = useRemote(
    (signal) => client.getReleaseManifest!(courseId, releaseId, signal),
    [client, courseId, releaseId],
  );
  return (
    <Dialog
      title="Edit draft bundle"
      onClose={onClose}
      pending={actions.pending}
    >
      <ActionFeedback actions={actions} />
      {remote.loading ? (
        <Loading label="Loading authorized draft bundle…" />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <Editor
            data={remote.data}
            pending={actions.pending}
            onSave={async (input) => {
              const result = await actions.run(
                JSON.stringify(["draft-bundle", releaseId, input]),
                (context) =>
                  client.updateRelease!(courseId, releaseId, input, context),
              );
              if (result) onClose();
            }}
          />
        )
      )}
    </Dialog>
  );
}
/** The draft route's request limit; a larger file could never be saved. */
export const MAX_MANIFEST_FILE_BYTES = 16 * 1024 * 1024;
const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** Reads a course manifest file chosen by staff. The text is only checked to be a JSON object that
 * is not a compiled bundle; the server validates the manifest itself when the draft is saved. */
export async function readManifestFile(
  file: Blob & { name: string },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (file.size > MAX_MANIFEST_FILE_BYTES)
    return { ok: false, error: `${file.name} is ${megabytes(file.size)}; a draft bundle can be at most ${megabytes(MAX_MANIFEST_FILE_BYTES)}. Nothing was loaded.` };
  let text: string, value: unknown;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: `${file.name} could not be read. Choose it again. Nothing was loaded.` };
  }
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: `${file.name} is not valid JSON. Choose the course's course.manifest.json. Nothing was loaded.` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: `${file.name} is not a course manifest (expected a JSON object). Choose course.manifest.json. Nothing was loaded.` };
  if ("formatVersion" in value && "server" in value)
    return { ok: false, error: `${file.name} is a compiled course bundle, not a course manifest. Choose course.manifest.json from the course's build output. Nothing was loaded.` };
  return { ok: true, text };
}
function Editor({
  data,
  pending,
  onSave,
}: {
  data: { manifest: unknown; notes: string; editable: boolean };
  pending: boolean;
  onSave: (value: { manifest: unknown; notes: string }) => void;
}) {
  const [source, setSource] = useState(JSON.stringify(data.manifest, null, 2)),
    [notes, setNotes] = useState(data.notes),
    [error, setError] = useState(""),
    [fileStatus, setFileStatus] = useState(""),
    [fileError, setFileError] = useState(""),
    [reading, setReading] = useState(false);
  const locked = pending || !data.editable;
  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget,
      file = input.files?.[0];
    if (!file) return;
    setReading(true);
    setFileStatus(`Reading ${file.name}…`);
    setFileError("");
    const result = await readManifestFile(file);
    setReading(false);
    // Clear the choice so choosing the same file again reloads it.
    input.value = "";
    if (!result.ok) {
      setFileStatus("");
      setFileError(result.error);
      return;
    }
    setSource(result.text);
    setError("");
    setFileStatus(`Loaded ${file.name} (${megabytes(file.size)}) into the bundle below. It is not saved until you validate and save the draft.`);
  };
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const manifest: unknown = JSON.parse(source);
          setError("");
          onSave({ manifest, notes });
        } catch {
          setError("Enter valid JSON before submitting the bundle.");
        }
      }}
    >
      <Notice tone="gold">
        Saving validates the full bundle with the released SDK and clears
        previous review approval. Published releases cannot be edited. Required
        runtime handlers are checked separately before publication.
      </Notice>
      <Field label="Load from file…" htmlFor="draft-file">
        <input
          id="draft-file"
          type="file"
          accept=".json,application/json"
          aria-describedby="draft-file-hint"
          onChange={(e) => void loadFile(e)}
          disabled={locked}
        />
        <small id="draft-file-hint">
          Choose course.manifest.json. It replaces the bundle text below;
          nothing is saved until you validate and save.
        </small>
      </Field>
      <div aria-live="polite" className="draft-file-status">
        {fileStatus && <p>{fileStatus}</p>}
      </div>
      {fileError && <Notice tone="red">{fileError}</Notice>}
      <Field label="Course bundle JSON" htmlFor="draft-json">
        <textarea
          className="manifest-editor"
          id="draft-json"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={locked}
          required
        />
      </Field>
      <Field label="Release notes" htmlFor="draft-notes">
        <textarea
          id="draft-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1200}
          disabled={locked}
        />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button type="submit" kind="primary" disabled={locked || reading}>
        {pending ? "Validating…" : "Validate and save draft"}
      </Button>
    </form>
  );
}
