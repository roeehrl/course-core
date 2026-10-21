import { useId, useRef, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  placementAuthorLimit,
  placementErrorMessage,
  type CoursePlacement,
  type EnrollmentPlacement,
  type PlacementAdminPort,
} from "../domain/placementAdmin";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  Stat,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";
import {
  useFormatters,
  useI18n,
  useT,
  type MessageKey,
  type Translate,
} from "../i18n";

/** A server code shown through the catalog; an unknown code is shown as is. */
const codeLabel = (
  t: Translate,
  has: (key: MessageKey) => boolean,
  key: string,
  code: string,
) =>
  has(key as MessageKey) ? t(key as MessageKey) : code.replaceAll("_", " ");

/** Placement administration: the staff switch and limits (which only tighten the author's), the
 * quality counters, and each learner's exemptions with the evidence behind them. */
export function PlacementView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.placement)
    return (
      <Card title={t("placementView.title")}>
        <EmptyState title={t("placementView.unavailable.title")}>
          {t("placementView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return <Placement port={client.placement} data={data} />;
}

function Placement({
  port,
  data,
}: {
  port: PlacementAdminPort;
  data: CourseWorkspace;
}) {
  const t = useT();
  const course = useRemote(
    (signal) => port.course(data.course.id, signal),
    [port, data.course.id],
  );
  const [enrollmentId, setEnrollmentId] = useState("");
  const [saved, setSaved] = useState("");
  const id = useId();
  if (course.loading) return <Loading label={t("placementView.loading")} />;
  if (course.error || !course.data)
    return <Notice tone="red">{placementErrorMessage(course.error, t)}</Notice>;
  const c = course.data;
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  return (
    <div className="page-stack">
      <div aria-live="polite">
        {saved && <Notice tone="green">{saved}</Notice>}
      </div>
      {!c.author?.enabled && (
        <Notice tone="gold">{t("placementView.notOffered")}</Notice>
      )}
      <div className="stats-grid">
        <Stat
          label={t("placementView.title")}
          value={
            c.effective?.enabled
              ? t("placementView.stat.on")
              : t("placementView.stat.off")
          }
          detail={
            c.settings.enabled
              ? t("placementView.stat.enabledByStaff")
              : t("placementView.stat.offUntilStaff")
          }
        />
        <Stat
          label={t("placementView.stat.exemptions")}
          value={c.counters?.exemptions ?? "—"}
          detail={t("placementView.stat.exemptions.detail")}
        />
        <Stat
          label={t("placementView.stat.falseSkips")}
          value={c.counters?.falseSkips.total ?? "—"}
          detail={
            c.counters
              ? t("placementView.stat.falseSkips.detail", {
                  revoked: c.counters.falseSkips.revokedByStaff,
                  failed: c.counters.falseSkips.laterFailed,
                })
              : t("placementView.stat.hidden")
          }
        />
        <Stat
          label={t("placementView.stat.repetitions")}
          value={c.counters?.unnecessaryRepetitions ?? "—"}
          detail={t("placementView.stat.repetitions.detail")}
        />
      </div>
      {data.permissions.includes("policy.write") ? (
        <SettingsForm
          port={port}
          catalogId={data.course.id}
          placement={c}
          onSaved={() => {
            setSaved(t("placementView.saved"));
            course.reload();
          }}
        />
      ) : (
        <Card title={t("placementView.settings")}>
          <p>
            {t("placementView.settings.summary", {
              state: c.settings.enabled ? "on" : "off",
              items: c.effective?.maxItems ?? 0,
              runs: c.settings.maxRuns,
              hours: c.settings.retestCooldownHours,
            })}
          </p>
        </Card>
      )}
      <Card title={t("placementView.learnerCard.title")}>
        <Field label={t("placementView.learner")} htmlFor={`${id}-learner`}>
          <select
            id={`${id}-learner`}
            value={enrollmentId}
            onChange={(e) => setEnrollmentId(e.target.value)}
          >
            <option value="">{t("placementView.chooseLearner")}</option>
            {learners.map((e) => (
              <option key={e.id} value={e.id} dir="auto">
                {e.profile.displayName}
              </option>
            ))}
          </select>
        </Field>
        {enrollmentId && (
          <EnrollmentPlacementPanel
            key={enrollmentId}
            port={port}
            enrollmentId={enrollmentId}
            revision={learners.find((e) => e.id === enrollmentId)?.revision}
            canRevoke={data.permissions.includes("enrollment.write")}
          />
        )}
      </Card>
    </div>
  );
}

function SettingsForm({
  port,
  catalogId,
  placement,
  onSaved,
}: {
  port: PlacementAdminPort;
  catalogId: string;
  placement: CoursePlacement;
  onSaved: () => void;
}) {
  const t = useT();
  const id = useId();
  const s = placement.settings,
    authorMax = placementAuthorLimit(placement);
  const [enabled, setEnabled] = useState(s.enabled);
  const [cooldown, setCooldown] = useState(String(s.retestCooldownHours));
  const [runs, setRuns] = useState(String(s.maxRuns));
  const [items, setItems] = useState(
    s.maxItems === null ? "" : String(s.maxItems),
  );
  const [families, setFamilies] = useState(
    s.minFamiliesPerEpisode === null ? "" : String(s.minFamiliesPerEpisode),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const itemsValue = num(items),
    familiesValue = num(families);
  const valid =
    Number.isInteger(Number(cooldown)) &&
    Number(cooldown) >= 0 &&
    Number(cooldown) <= 8760 &&
    Number.isInteger(Number(runs)) &&
    Number(runs) >= 1 &&
    Number(runs) <= 10 &&
    (itemsValue === null ||
      (Number.isInteger(itemsValue) &&
        authorMax !== null &&
        itemsValue >= 1 &&
        itemsValue <= authorMax)) &&
    (familiesValue === null ||
      (Number.isInteger(familiesValue) &&
        familiesValue >= 1 &&
        familiesValue <= 10));
  return (
    <Card title={t("placementView.settings")}>
      <form
        className="input-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          port
            .save(catalogId, {
              expectedRevision: s.revision,
              enabled,
              retestCooldownHours: Number(cooldown),
              maxRuns: Number(runs),
              maxItems: itemsValue,
              minFamiliesPerEpisode: familiesValue,
            })
            .then(onSaved, setError)
            .finally(() => setPending(false));
        }}
      >
        <label className="check-label wide">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t("placementView.form.offer")}
        </label>
        <Field
          label={t("placementView.form.cooldown")}
          htmlFor={`${id}-cooldown`}
          hint={t("placementView.form.cooldown.hint")}
        >
          <input
            id={`${id}-cooldown`}
            type="number"
            min={0}
            max={8760}
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </Field>
        <Field
          label={t("placementView.form.runs")}
          htmlFor={`${id}-runs`}
          hint={t("placementView.form.runs.hint")}
        >
          <input
            id={`${id}-runs`}
            type="number"
            min={1}
            max={10}
            value={runs}
            onChange={(e) => setRuns(e.target.value)}
          />
        </Field>
        <Field
          label={t("placementView.form.items")}
          htmlFor={`${id}-items`}
          hint={
            authorMax === null
              ? t("placementView.form.items.hintNone")
              : t("placementView.form.items.hint", { max: authorMax })
          }
        >
          <input
            id={`${id}-items`}
            type="number"
            min={1}
            max={authorMax ?? undefined}
            value={items}
            onChange={(e) => setItems(e.target.value)}
          />
        </Field>
        <Field
          label={t("placementView.form.families")}
          htmlFor={`${id}-families`}
          hint={t("placementView.form.families.hint")}
        >
          <input
            id={`${id}-families`}
            type="number"
            min={1}
            max={10}
            value={families}
            onChange={(e) => setFamilies(e.target.value)}
          />
        </Field>
        <div className="wide stack">
          {error !== undefined && (
            <Notice tone="red">{placementErrorMessage(error, t)}</Notice>
          )}
          <Button kind="primary" type="submit" disabled={pending || !valid}>
            {t("placementView.form.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EnrollmentPlacementPanel({
  port,
  enrollmentId,
  revision,
  canRevoke,
}: {
  port: PlacementAdminPort;
  enrollmentId: string;
  revision: number | undefined;
  canRevoke: boolean;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const view = useRemote(
    (signal) => port.enrollment(enrollmentId, signal),
    [port, enrollmentId],
  );
  const [currentRevision, setCurrentRevision] = useState(revision);
  if (view.loading)
    return <Loading label={t("placementView.loadingLearner")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{placementErrorMessage(view.error, t)}</Notice>;
  const v: EnrollmentPlacement = view.data;
  return (
    <div className="stack">
      {v.runs.length === 0 ? (
        <p className="muted">{t("placementView.noRun")}</p>
      ) : (
        <ul className="placement-runs" aria-label={t("placementView.runs")}>
          {v.runs.map((r) => (
            <li key={r.runNumber}>
              {i18n.rich(
                "placementView.run",
                {
                  number: r.runNumber,
                  state: codeLabel(
                    t,
                    i18n.has,
                    `placementView.state.${r.state}`,
                    r.state,
                  ),
                },
                {
                  state: (children, key) => <Badge key={key}>{children}</Badge>,
                },
              )}{" "}
              {r.itemsUsed !== null &&
                t("placementView.run.questions", { count: r.itemsUsed })}{" "}
              {r.stopReason &&
                t("placementView.run.stopReason", {
                  reason: codeLabel(
                    t,
                    i18n.has,
                    `placementView.stopReason.${r.stopReason}`,
                    r.stopReason,
                  ),
                })}
            </li>
          ))}
        </ul>
      )}
      {v.exemptions.map((x) => (
        <ExemptionCard
          key={x.episodeId}
          exemption={x}
          version={v.release.version}
          canRevoke={canRevoke && currentRevision !== undefined}
          onRevoke={async (reason, key) => {
            const result = (await port.revoke(
              enrollmentId,
              x.episodeId,
              { reason, expectedRevision: currentRevision! },
              key,
            )) as { revision?: number };
            if (typeof result.revision === "number")
              setCurrentRevision(result.revision);
            view.reload();
          }}
        />
      ))}
      {v.overrides.map((o) => (
        <Notice
          key={o.episodeId + o.at}
          tone="gold"
          title={t("placementView.override.title", { title: o.title })}
        >
          <bdi>{o.revokedBy}</bdi> · {when(o.at)} ·{" "}
          <span dir="auto">{o.reason}</span>
        </Notice>
      ))}
    </div>
  );
}

function ExemptionCard({
  exemption,
  version,
  canRevoke,
  onRevoke,
}: {
  exemption: EnrollmentPlacement["exemptions"][number];
  version: string;
  canRevoke: boolean;
  onRevoke: (reason: string, key: string) => Promise<void>;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const id = useId();
  const key = useRef("placement-revoke-" + randomId());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <section
      className="placement-exemption"
      aria-label={t("placementView.exemption.label", {
        title: exemption.title,
      })}
    >
      <p>
        {i18n.rich(
          exemption.placedAt
            ? "placementView.exemption.placedAt"
            : "placementView.exemption.placed",
          {
            title: exemption.title,
            run: exemption.runNumber ?? "?",
            version,
            ...(exemption.placedAt ? { date: when(exemption.placedAt) } : {}),
          },
          {
            title: (children, key) => (
              <strong key={key} dir="auto">
                {children}
              </strong>
            ),
          },
        )}
      </p>
      <ul className="placement-runs">
        {exemption.evidence.map((e) => (
          <li key={e.evidenceId}>
            {t("placementView.evidence", {
              assessment: e.assessmentId,
              family: e.familyId,
              result: e.passed ? "correct" : "incorrect",
              mode: e.independent ? "independent" : "assisted",
            })}
            {e.invalidated && (
              <Badge tone="red">
                {t("placementView.evidence.invalidated")}
              </Badge>
            )}
            {!e.sameCourseVersion && (
              <Badge tone="gold">
                {t("placementView.evidence.otherVersion")}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {canRevoke && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(undefined);
            onRevoke(reason.trim(), key.current)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          <Field
            label={t("placementView.revoke.reason")}
            htmlFor={`${id}-reason`}
            hint={t("placementView.revoke.reason.hint")}
          >
            <textarea
              id={`${id}-reason`}
              dir="auto"
              rows={2}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {error !== undefined && (
            <Notice tone="red">{placementErrorMessage(error, t)}</Notice>
          )}
          <Button
            kind="danger"
            type="submit"
            disabled={pending || reason.trim().length < 10}
          >
            {t("placementView.revoke")}
          </Button>
        </form>
      )}
    </section>
  );
}
