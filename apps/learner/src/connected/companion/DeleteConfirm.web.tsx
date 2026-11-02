import React, { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";
import { Popover } from "../ui/Popover.web";
import { StatusLine } from "../ui/StatusLine.web";

/**
 * Asks before a question and its answer are deleted (final design §3.7): a 320 px popover at the
 * question, focus on Cancel, Esc cancels, Delete in `--danger`. While it deletes, Delete waits; if
 * it could not, the popover stays and says so. It is drawn at the companion's own level (a portal
 * into `#connected-companion`), so no later message paints over it.
 */
export function DeleteConfirm({ open, anchor, onCancel, onDelete }: {
  open: boolean;
  anchor: React.RefObject<HTMLElement | null>;
  onCancel: () => void;
  /** Deletes; rejects when the question could not be deleted. */
  onDelete: () => Promise<void>;
}) {
  const t = useT();
  const text = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = () => {
    setFailed(false);
    onCancel();
  };
  if (!open) return null;
  return createPortal(
    <Popover open={open} onClose={close} anchor={anchor} labelledBy={text} width={320} initialFocus={cancel} className="cc-act-confirm">
      <p id={text} className="cc-act-confirm-text">{t("deleteConfirm.text")}</p>
      {failed && <StatusLine tone="error" text={t("deleteConfirm.error")} className="cc-act-confirm-error" />}
      <div className="cc-act-confirm-actions">
        <button ref={cancel} type="button" className="cc-ui-pill cc-ui-pill-36 cc-act-cancel" onClick={close}>
          {t("deleteConfirm.cancel")}
        </button>
        <button
          type="button"
          className="cc-ui-pill cc-ui-pill-36 cc-act-delete"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            setFailed(false);
            onDelete().then(
              () => setDeleting(false),
              () => {
                setDeleting(false);
                setFailed(true);
              },
            );
          }}
        >
          {t("deleteConfirm.delete")}
        </button>
      </div>
    </Popover>,
    document.getElementById("connected-companion") ?? document.body,
  );
}
