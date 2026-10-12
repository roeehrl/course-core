import { useState } from "react";
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
    [error, setError] = useState("");
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
      <Field label="Course bundle JSON" htmlFor="draft-json">
        <textarea
          className="manifest-editor"
          id="draft-json"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={pending || !data.editable}
          required
        />
      </Field>
      <Field label="Release notes" htmlFor="draft-notes">
        <textarea
          id="draft-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1200}
          disabled={pending || !data.editable}
        />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <Button type="submit" kind="primary" disabled={pending || !data.editable}>
        {pending ? "Validating…" : "Validate and save draft"}
      </Button>
    </form>
  );
}
