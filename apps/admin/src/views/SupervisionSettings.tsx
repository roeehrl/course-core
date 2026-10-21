import { useId, useRef, useState } from "react";
import { Check, Eye, X } from "lucide-react";
import {
  autonomyLevels,
  supervisionErrorMessage,
  type AuthorityRequest,
  type AutonomyLevel,
  type LearnerBudget,
  type SettingsPreview,
  type SupervisionSettingsPort,
} from "../domain/supervision";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, Field, Loading, Notice } from "../components/ui";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

/** A server code shown in words when the catalog has no label for it. */
const humanize = (code: string) => code.toLowerCase().replaceAll(/[._]/g, " ");
function useLabel() {
  const i18n = useI18n();
  return (key: string, code: string) =>
    i18n.has(key as MessageKey) ? i18n.t(key as MessageKey) : humanize(code);
}

/**
 * How far the supervisor may act on its own and which kinds of tools it may use, for the whole
 * workspace (owner/admin). The page shows what a choice would change before it can be saved.
 */
export function SupervisionSettingsCard({
  port,
  workspaceId,
}: {
  port: SupervisionSettingsPort;
  workspaceId: string;
}) {
  const { t } = useI18n();
  const label = useLabel();
  const id = useId();
  const view = useRemote(
    (signal) => port.load(workspaceId, signal),
    [port, workspaceId],
  );
  const [level, setLevel] = useState<AutonomyLevel | null>(null);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<{
    key: string;
    result: SettingsPreview;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  if (view.loading && !view.data)
    return <Loading label={t("supervisionSettings.loading")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{supervisionErrorMessage(view.error, t)}</Notice>;
  const saved = view.data;
  const chosenLevel = level ?? saved.autonomyLevel;
  const chosenFamilies = families ?? saved.permittedToolFamilies;
  const allFamilies = saved.families ?? [];
  const choiceKey = `${chosenLevel}:${[...chosenFamilies].sort().join(",")}`;
  const unchanged =
    chosenLevel === saved.autonomyLevel &&
    [...chosenFamilies].sort().join(",") ===
      [...saved.permittedToolFamilies].sort().join(",");
  const previewed = preview?.key === choiceKey ? preview.result : null;
  async function check() {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await port.preview(workspaceId, {
        autonomyLevel: chosenLevel,
        permittedToolFamilies: chosenFamilies,
      });
      setPreview({ key: choiceKey, result });
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    setPending(true);
    setError(undefined);
    try {
      await port.save(workspaceId, {
        expectedRevision: saved.revision,
        autonomyLevel: chosenLevel,
        permittedToolFamilies: chosenFamilies,
      });
      setLevel(null);
      setFamilies(null);
      setPreview(null);
      setMessage(t("supervisionSettings.saved"));
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title={t("supervisionSettings.title")}>
      <div className="stack">
        <p>{t("supervisionSettings.intro")}</p>
        <p>{t("supervisionSettings.admission")}</p>
        <fieldset className="stack">
          <legend className="section-title">
            {t("supervisionSettings.autonomy.title")}
          </legend>
          {autonomyLevels.map((value) => (
            <label key={value} className="choice-row">
              <input
                type="radio"
                name={`${id}-level`}
                value={value}
                checked={chosenLevel === value}
                onChange={() => setLevel(value)}
              />{" "}
              <span>
                <strong>
                  {t(`supervisionSettings.autonomy.${value}` as MessageKey)}
                </strong>
                <br />
                <span className="muted">
                  {t(
                    `supervisionSettings.autonomy.${value}.help` as MessageKey,
                  )}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="stack">
          <legend className="section-title">
            {t("supervisionSettings.families.title")}
          </legend>
          <p className="muted">{t("supervisionSettings.families.help")}</p>
          {allFamilies.map((family) => (
            <label key={family.id} className="choice-row">
              <input
                type="checkbox"
                checked={chosenFamilies.includes(family.id)}
                onChange={(e) =>
                  setFamilies(
                    e.target.checked
                      ? [...chosenFamilies, family.id]
                      : chosenFamilies.filter((f) => f !== family.id),
                  )
                }
              />{" "}
              <span>
                <strong>
                  {label(`supervisionSettings.family.${family.id}`, family.id)}
                </strong>
                <br />
                <span className="muted">
                  {label(
                    `supervisionSettings.family.${family.id}.help`,
                    family.id,
                  )}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div aria-live="polite">
          {message && <Notice tone="green">{message}</Notice>}
          {error !== undefined && (
            <Notice tone="red">{supervisionErrorMessage(error, t)}</Notice>
          )}
        </div>
        {previewed && (
          <Notice tone="blue" title={t("supervisionSettings.preview.title")}>
            <ul>
              {previewed.effects.map((effect) => (
                <li key={effect}>
                  {label(`supervisionSettings.effect.${effect}`, effect)}
                </li>
              ))}
            </ul>
            <p>
              {t("supervisionSettings.preview.affected", {
                learners: previewed.optedInLearners,
                actions: previewed.openTeachingActions,
              })}
            </p>
            {previewed.toolsRemoved.length > 0 && (
              <p>
                {t("supervisionSettings.preview.removed", {
                  count: previewed.toolsRemoved.length,
                })}{" "}
                <span dir="ltr" className="muted">
                  {previewed.toolsRemoved.join(", ")}
                </span>
              </p>
            )}
            {previewed.toolsAdded.length > 0 && (
              <p>
                {t("supervisionSettings.preview.added", {
                  count: previewed.toolsAdded.length,
                })}{" "}
                <span dir="ltr" className="muted">
                  {previewed.toolsAdded.join(", ")}
                </span>
              </p>
            )}
            {previewed.warnings.map((warning) => (
              <Notice key={warning} tone="gold">
                {label(`supervisionSettings.warning.${warning}`, warning)}
              </Notice>
            ))}
          </Notice>
        )}
        <div className="tag-row">
          <Button disabled={pending || unchanged} onClick={() => void check()}>
            <Eye size={16} aria-hidden="true" />{" "}
            {t("supervisionSettings.check")}
          </Button>
          <Button
            kind="primary"
            disabled={pending || unchanged || !previewed}
            onClick={() => void save()}
          >
            {t("supervisionSettings.save")}
          </Button>
        </div>
        {!unchanged && !previewed && (
          <p className="muted">{t("supervisionSettings.checkFirst")}</p>
        )}
      </div>
    </Card>
  );
}

/** Changes the supervisor may not make itself, waiting for an owner or admin. */
export function AuthorityQueueCard({
  port,
  workspaceId,
}: {
  port: SupervisionSettingsPort;
  workspaceId: string;
}) {
  const { t } = useI18n();
  const { when, money } = useFormatters();
  const label = useLabel();
  const view = useRemote(
    (signal) => port.requests(workspaceId, signal),
    [port, workspaceId],
  );
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  if (view.loading && !view.data)
    return <Loading label={t("supervisionSettings.requests.loading")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{supervisionErrorMessage(view.error, t)}</Notice>;
  async function decide(
    request: AuthorityRequest,
    decision: "approve" | "reject",
  ) {
    const fingerprint = `${request.requestId}:${decision}`;
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "authority-" + randomId()));
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await port.decide(workspaceId, request.requestId, {
        idempotencyKey: key,
        decision,
      });
      setMessage(
        t(
          decision === "approve"
            ? "supervisionSettings.requests.approved"
            : "supervisionSettings.requests.rejected",
        ),
      );
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  const pendingRequests = view.data.requests.filter(
    (r) => r.state === "pending",
  );
  const decided = view.data.requests
    .filter((r) => r.state !== "pending")
    .slice(0, 10);
  const describe = (r: AuthorityRequest) =>
    r.kind === "paid_ceiling" && r.proposal.limitMicroUsd !== undefined
      ? t("supervisionSettings.requests.proposal.paid_ceiling", {
          amount: money(Math.round(r.proposal.limitMicroUsd / 10_000)),
        })
      : r.proposal.objectiveIds
        ? t("supervisionSettings.requests.proposal.objectives", {
            objectives: r.proposal.objectiveIds.join(", "),
          })
        : "";
  return (
    <Card title={t("supervisionSettings.requests.title")}>
      <div className="stack">
        <p>{t("supervisionSettings.requests.intro")}</p>
        <div aria-live="polite">
          {message && <Notice tone="green">{message}</Notice>}
          {error !== undefined && (
            <Notice tone="red">{supervisionErrorMessage(error, t)}</Notice>
          )}
        </div>
        {pendingRequests.length === 0 ? (
          <p className="muted">{t("supervisionSettings.requests.empty")}</p>
        ) : (
          <ul className="stack">
            {pendingRequests.map((r) => (
              <li key={r.requestId} className="stack">
                <strong>
                  {label(`supervisionSettings.requests.kind.${r.kind}`, r.kind)}
                </strong>
                <span dir="auto">
                  {t("supervisionSettings.requests.for", {
                    learner:
                      r.learnerName ||
                      t("supervisionSettings.requests.unnamed"),
                    when: when(r.createdAt),
                  })}
                </span>
                {describe(r) && <span dir="auto">{describe(r)}</span>}
                {r.reason && (
                  <span className="muted" dir="auto">
                    {t("supervisionSettings.requests.reason", {
                      reason: r.reason,
                    })}
                  </span>
                )}
                {r.kind !== "paid_ceiling" && (
                  <span className="muted">
                    {t("supervisionSettings.requests.authorsAct")}
                  </span>
                )}
                <div className="tag-row">
                  <Button
                    kind="primary"
                    disabled={pending}
                    onClick={() => void decide(r, "approve")}
                  >
                    <Check size={16} aria-hidden="true" />{" "}
                    {t("supervisionSettings.requests.approve")}
                  </Button>
                  <Button
                    kind="danger"
                    disabled={pending}
                    onClick={() => void decide(r, "reject")}
                  >
                    <X size={16} aria-hidden="true" />{" "}
                    {t("supervisionSettings.requests.reject")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {decided.length > 0 && (
          <>
            <h3 className="section-title">
              {t("supervisionSettings.requests.decided")}
            </h3>
            <ul>
              {decided.map((r) => (
                <li key={r.requestId}>
                  {label(`supervisionSettings.requests.kind.${r.kind}`, r.kind)}{" "}
                  <Badge tone={r.state === "approved" ? "green" : "neutral"}>
                    {label(
                      `supervisionSettings.requests.state.${r.state}`,
                      r.state,
                    )}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

const toDollars = (microUsd: number | undefined) =>
  microUsd === undefined ? "" : String(microUsd / 1_000_000);
const fromDollars = (value: string) => Math.round(Number(value) * 1_000_000);
/** One learner's AI spending limits per day and per lesson (per day), in dollars and tokens. */
export function LearnerBudgetCard({
  port,
  workspaceId,
  enrollmentId,
}: {
  port: SupervisionSettingsPort;
  workspaceId: string;
  enrollmentId: string;
}) {
  const { t } = useI18n();
  const { money } = useFormatters();
  const id = useId();
  const view = useRemote(
    (signal) => port.budget(workspaceId, enrollmentId, signal),
    [port, workspaceId, enrollmentId],
  );
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  if (view.loading && !view.data)
    return <Loading label={t("supervisionSettings.budget.loading")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{supervisionErrorMessage(view.error, t)}</Notice>;
  const b: LearnerBudget = view.data;
  const values = form ?? {
    dailyUsd: toDollars(b.daily?.microUsd),
    dailyTokens: b.daily ? String(b.daily.tokens) : "",
    lessonUsd: toDollars(b.artifact?.microUsd),
    lessonTokens: b.artifact ? String(b.artifact.tokens) : "",
  };
  const set = (field: string, value: string) =>
    setForm({ ...values, [field]: value });
  const pair = (usd: string, tokens: string) =>
    usd.trim() === "" && tokens.trim() === ""
      ? null
      : {
          microUsd: fromDollars(usd || "0"),
          tokens: Math.round(Number(tokens || "0")),
        };
  const invalid = [
    values.dailyUsd,
    values.dailyTokens,
    values.lessonUsd,
    values.lessonTokens,
  ].some(
    (v) => v!.trim() !== "" && (!Number.isFinite(Number(v)) || Number(v) < 0),
  );
  async function save(clear = false) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await port.saveBudget(
        workspaceId,
        enrollmentId,
        clear
          ? { daily: null, artifact: null }
          : {
              daily: pair(values.dailyUsd!, values.dailyTokens!),
              artifact: pair(values.lessonUsd!, values.lessonTokens!),
            },
      );
      setForm(null);
      setMessage(
        t(
          clear
            ? "supervisionSettings.budget.cleared"
            : "supervisionSettings.budget.saved",
        ),
      );
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  const usd = (microUsd: number) => money(Math.round(microUsd / 10_000));
  return (
    <section className="stack" aria-labelledby={`${id}-title`}>
      <h3 className="section-title" id={`${id}-title`}>
        {t("supervisionSettings.budget.title")}
      </h3>
      <p className="muted">{t("supervisionSettings.budget.intro")}</p>
      <p>
        {t("supervisionSettings.budget.usedToday", {
          amount: usd(b.usedToday.microUsd),
          tokens: b.usedToday.tokens,
        })}
        {b.usedInCurrentLessonToday && (
          <>
            {" "}
            {t("supervisionSettings.budget.usedLesson", {
              amount: usd(b.usedInCurrentLessonToday.microUsd),
            })}
          </>
        )}
      </p>
      <div className="form-grid">
        <Field
          label={t("supervisionSettings.budget.dailyUsd")}
          htmlFor={`${id}-du`}
          hint={t("supervisionSettings.budget.emptyMeansNone")}
        >
          <input
            id={`${id}-du`}
            inputMode="decimal"
            value={values.dailyUsd}
            onChange={(e) => set("dailyUsd", e.target.value)}
          />
        </Field>
        <Field
          label={t("supervisionSettings.budget.dailyTokens")}
          htmlFor={`${id}-dt`}
        >
          <input
            id={`${id}-dt`}
            inputMode="numeric"
            value={values.dailyTokens}
            onChange={(e) => set("dailyTokens", e.target.value)}
          />
        </Field>
        <Field
          label={t("supervisionSettings.budget.lessonUsd")}
          htmlFor={`${id}-lu`}
          hint={t("supervisionSettings.budget.lessonHint")}
        >
          <input
            id={`${id}-lu`}
            inputMode="decimal"
            value={values.lessonUsd}
            onChange={(e) => set("lessonUsd", e.target.value)}
          />
        </Field>
        <Field
          label={t("supervisionSettings.budget.lessonTokens")}
          htmlFor={`${id}-lt`}
        >
          <input
            id={`${id}-lt`}
            inputMode="numeric"
            value={values.lessonTokens}
            onChange={(e) => set("lessonTokens", e.target.value)}
          />
        </Field>
      </div>
      <p className="muted">
        {b.dayBoundary === "course_time_zone" && b.dayTimeZone
          ? t("supervisionSettings.budget.courseZone", { zone: b.dayTimeZone })
          : t("supervisionSettings.budget.utc")}{" "}
        {t("supervisionSettings.budget.mediaCounts")}
      </p>
      <div aria-live="polite">
        {invalid && (
          <Notice tone="gold">{t("supervisionSettings.budget.invalid")}</Notice>
        )}
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{supervisionErrorMessage(error, t)}</Notice>
        )}
      </div>
      <div className="tag-row">
        <Button
          kind="primary"
          disabled={pending || invalid || form === null}
          onClick={() => void save()}
        >
          {t("supervisionSettings.budget.save")}
        </Button>
        {(b.daily || b.artifact) && (
          <Button
            kind="quiet"
            disabled={pending}
            onClick={() => void save(true)}
          >
            {t("supervisionSettings.budget.clear")}
          </Button>
        )}
      </div>
    </section>
  );
}
