import { useState, type ChangeEvent } from "react";
import type { AdminClient } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { useRemote } from "../hooks/useAdmin";
import { ActionFeedback } from "./ActionFeedback";
import { Button, Dialog, ErrorState, Field, Loading, Notice } from "./ui";
import {
  englishTranslator,
  useI18n,
  useT,
  type AdminTranslator,
} from "../i18n";

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
  const t = useT();
  const remote = useRemote(
    (signal) => client.getReleaseManifest!(courseId, releaseId, signal),
    [client, courseId, releaseId],
  );
  return (
    <Dialog
      title={t("draftEditor.title")}
      onClose={onClose}
      pending={actions.pending}
    >
      <ActionFeedback actions={actions} />
      {remote.loading ? (
        <Loading label={t("draftEditor.loading")} />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <DraftEditorBody
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
type Formatter = Pick<AdminTranslator, "t" | "number">;
const megabytes = (i18n: Formatter, bytes: number) =>
  i18n.t("draftEditor.size.mb", {
    size: i18n.number(bytes / (1024 * 1024), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
/** Reads a course manifest file chosen by staff. The text is only checked to be a JSON object that
 * is not a compiled bundle; the server validates the manifest itself when the draft is saved. */
export async function readManifestFile(
  file: Blob & { name: string },
  i18n: Formatter = englishTranslator(),
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (file.size > MAX_MANIFEST_FILE_BYTES)
    return {
      ok: false,
      error: i18n.t("draftEditor.file.tooLarge", {
        name: file.name,
        size: megabytes(i18n, file.size),
        max: megabytes(i18n, MAX_MANIFEST_FILE_BYTES),
      }),
    };
  let text: string, value: unknown;
  try {
    text = await file.text();
  } catch {
    return {
      ok: false,
      error: i18n.t("draftEditor.file.unreadable", { name: file.name }),
    };
  }
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: i18n.t("draftEditor.file.notJson", { name: file.name }),
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      error: i18n.t("draftEditor.file.notObject", { name: file.name }),
    };
  if ("formatVersion" in value && "server" in value)
    return {
      ok: false,
      error: i18n.t("draftEditor.file.compiled", { name: file.name }),
    };
  return { ok: true, text };
}
export function DraftEditorBody({
  data,
  pending,
  onSave,
}: {
  data: { manifest: unknown; notes: string; editable: boolean };
  pending: boolean;
  onSave: (value: { manifest: unknown; notes: string }) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
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
    setFileStatus(t("draftEditor.file.reading", { name: file.name }));
    setFileError("");
    const result = await readManifestFile(file, i18n);
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
    setFileStatus(
      t("draftEditor.file.loaded", {
        name: file.name,
        size: megabytes(i18n, file.size),
      }),
    );
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
          setError(t("draftEditor.invalidJson"));
        }
      }}
    >
      <Notice tone="gold">{t("draftEditor.notice")}</Notice>
      <Field label={t("draftEditor.file.label")} htmlFor="draft-file">
        <input
          id="draft-file"
          type="file"
          accept=".json,application/json"
          aria-describedby="draft-file-hint"
          onChange={(e) => void loadFile(e)}
          disabled={locked}
        />
        <small id="draft-file-hint">{t("draftEditor.file.hint")}</small>
      </Field>
      <div aria-live="polite" className="draft-file-status">
        {fileStatus && <p>{fileStatus}</p>}
      </div>
      {fileError && <Notice tone="red">{fileError}</Notice>}
      <Field label={t("draftEditor.bundle.label")} htmlFor="draft-json">
        <textarea
          className="manifest-editor"
          id="draft-json"
          dir="ltr"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={locked}
          required
        />
      </Field>
      <Field label={t("draftEditor.notes.label")} htmlFor="draft-notes">
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
        {pending ? t("draftEditor.validating") : t("draftEditor.submit")}
      </Button>
    </form>
  );
}
