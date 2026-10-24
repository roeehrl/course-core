import { Button, Notice } from "./ui";
import { useT } from "../i18n";

/** Shown when the saved version of a form changes while it has unsaved edits: the person
 * chooses to see the saved version (dropping the edits) or to keep editing and save over it. */
export function ChangedElsewhere({
  onShowSaved,
  onKeep,
  disabled,
}: {
  onShowSaved: () => void;
  onKeep: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Notice tone="gold" title={t("changedElsewhere.title")}>
      <p>{t("changedElsewhere.body")}</p>
      <div className="tag-row">
        <Button type="button" disabled={disabled} onClick={onShowSaved}>
          {t("changedElsewhere.showSaved")}
        </Button>
        <Button type="button" kind="quiet" disabled={disabled} onClick={onKeep}>
          {t("changedElsewhere.keep")}
        </Button>
      </div>
    </Notice>
  );
}
