import { useEffect, useId, useMemo, useState } from "react";
import { activeRoles, type SectionState } from "../../domain/aiServices";
import type { AiKey } from "../../text/aiServices";
import type { SectionProps } from "./AiServicesPage";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  Section,
  described,
  errorText,
  jobName,
  useRequestKeys,
  useAiText,
  type FieldError,
} from "./shared";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
const MIN_REASON = 20;

/**
 * The quality-check gate, on the page: which models wait for a check, and (owners only) the
 * audited approval without one, after which the waiting models turn on. The server resolves
 * the exact version being approved from the draft; nobody copies a fingerprint.
 */
export function CheckSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, owner, reload, activate, onDirty } = props;
  const base = useId().replaceAll(":", "");
  const draft = data.draft;
  const waiting =
    draft?.roles.filter((r) => draft.waitingForCheck.includes(r.role)) ?? [];
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  const keys = useRequestKeys();
  useEffect(() => onDirty(!!reason.trim()), [reason, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const active = useMemo(
    () => activeRoles(data.setup.configuration),
    [data.setup.configuration],
  );
  const dialogues = (data.evals?.suite.coverage ?? [])
    .filter((c) => waiting.some((w) => w.role === c.role))
    .reduce((sum, c) => sum + c.dialogues, 0);
  const reasonId = `${base}-reason`;
  async function approve() {
    if (!draft) return;
    setMessage(undefined);
    if (reason.trim().length < MIN_REASON) {
      setErrors([{ field: reasonId, message: t("check.errReason") }]);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      for (const role of draft.waitingForCheck) {
        const request = { draftId: draft.id, role, reason: reason.trim() };
        await port.approve(workspaceId, {
          ...request,
          idempotencyKey: keys.key(request),
        });
      }
      keys.settle();
      if (await activate(draft)) {
        setReason("");
        setMessage({ tone: "ok", text: t("check.approved") });
      }
      await reload();
    } catch (error) {
      keys.settle(error);
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  const reasonError = errors.find((e) => e.field === reasonId)?.message;
  return (
    <Section
      id="check"
      title={t("section.check")}
      state={props.state}
      unsaved={props.unsaved}
    >
      {message && <Message tone={message.tone}>{message.text}</Message>}
      {waiting.length ? (
        <>
          <p>{t("check.notChecked", { count: waiting.length })}</p>
          <ul className="ai-list">
            {waiting.map((r) => (
              <li key={r.role}>
                {jobName(t, r.role)} —{" "}
                <Ltr className="mono">{r.remoteModel ?? r.modelId}</Ltr>
              </li>
            ))}
          </ul>
          {dialogues > 0 && <p>{t("check.explain", { dialogues })}</p>}
          <Message tone="info">{t("check.notHere")}</Message>
          <p className="ai-muted">{t("check.disclaimer")}</p>
          {owner ? (
            <form
              className="ai-form ai-approve"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void approve();
              }}
            >
              <h3>{t("check.approveTitle")}</h3>
              <ErrorSummary errors={errors} />
              <Field
                id={reasonId}
                label={t("check.reasonLabel")}
                hint={t("check.reasonHint")}
                error={reasonError}
              >
                <textarea
                  id={reasonId}
                  dir="auto"
                  rows={3}
                  maxLength={1000}
                  value={reason}
                  disabled={saving}
                  onChange={(event) => setReason(event.target.value)}
                  {...described(reasonId, true, reasonError)}
                />
              </Field>
              <p className="ai-muted" aria-live="polite">
                {t("check.reasonCount", { count: reason.trim().length })}
              </p>
              <div className="ai-actions">
                <button
                  type="submit"
                  className="button primary"
                  disabled={saving}
                >
                  {saving ? t("check.approving") : t("check.approve")}
                </button>
              </div>
            </form>
          ) : (
            <Message tone="warn">{t("check.approveOwnersOnly")}</Message>
          )}
        </>
      ) : (
        <p>{t("check.nothingWaiting")}</p>
      )}
      <h3>{t("check.onTitle")}</h3>
      {active.length ? (
        <ul className="ai-list">
          {active.map((role) => {
            const state = data.evals?.roles.find((r) => r.role === role.role);
            return (
              <li key={role.role}>
                {jobName(t, role.role)} —{" "}
                <Ltr className="mono">{role.remoteModel ?? role.modelId}</Ltr>
                {state && (
                  <span className="ai-muted">
                    {" "}
                    · {t(`check.state.${state.status}` as AiKey)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ai-muted">{t("check.noneOn")}</p>
      )}
    </Section>
  );
}
