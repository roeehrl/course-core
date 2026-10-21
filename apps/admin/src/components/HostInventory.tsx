import { useState } from "react";
import { Download } from "lucide-react";
import { platformErrorMessage, type PlatformPort } from "../domain/platform";
import { Button, Card, Notice } from "./ui";
import { useT } from "../i18n";

// i18n-ignore: a command line, the same in every locale
const COMMAND = "course compat course.json --host host-inventory.json";

/** Downloads what this Core has installed, so a course author can check a course against this
 * exact host before packing it (`course compat --host <file>`). The download is audited. */
export function HostInventory({
  port,
  workspaceId,
}: {
  port: PlatformPort;
  workspaceId: string;
}) {
  const t = useT();
  const [state, setState] = useState<{
    pending: boolean;
    error?: unknown;
    digest?: string;
  }>({ pending: false });
  return (
    <Card title={t("hostInventory.title")} eyebrow={t("hostInventory.eyebrow")}>
      <p>{t("hostInventory.intro")}</p>
      <p>
        {t("hostInventory.howTo")} <code dir="ltr">{COMMAND}</code>
      </p>
      <small>{t("hostInventory.privacy")}</small>
      {state.error !== undefined && (
        <Notice tone="red">{platformErrorMessage(state.error, t)}</Notice>
      )}
      {state.digest && (
        <Notice tone="green">
          {t("hostInventory.done")}{" "}
          <small className="mono" dir="ltr">
            {state.digest.slice(0, 16)}
          </small>
        </Notice>
      )}
      <Button
        kind="primary"
        disabled={state.pending}
        onClick={async () => {
          setState({ pending: true });
          try {
            const file = await port.hostInventory(workspaceId);
            const url = URL.createObjectURL(file.body);
            const link = document.createElement("a");
            link.href = url;
            link.download = file.fileName;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setState({ pending: false, digest: file.digest });
          } catch (error) {
            setState({ pending: false, error });
          }
        }}
      >
        <Download size={16} aria-hidden="true" />
        {state.pending
          ? t("hostInventory.downloading")
          : t("hostInventory.download")}
      </Button>
    </Card>
  );
}
