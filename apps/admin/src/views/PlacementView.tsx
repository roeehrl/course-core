import { useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  placementAuthorLimit,
  placementErrorMessage,
  type CoursePlacement,
  type EnrollmentPlacement,
  type PlacementAdminPort,
  type PlacementBlueprint,
  type PlacementSettingsInput,
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
import { SkeletonRows, shortTitle } from "./contentShared";
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
  if (course.loading)
    return (
      <div className="page-stack">
        <SkeletonRows label={t("placementView.loading")} rows={3} />
        <Card title={t("placementView.settings")}>
          <SkeletonRows label={t("placementView.loading")} rows={6} />
        </Card>
      </div>
    );
  if (course.error || !course.data)
    return <Notice tone="red">{placementErrorMessage(course.error, t)}</Notice>;
  const c = course.data;
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  return (
    <div className="page-stack">
      <div aria-live="polite" className="cv-live">
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
            questionTitle={(id) =>
              c.author?.items.find((i) => i.assessmentId === id)?.prompt ?? id
            }
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
  const [excludedItems, setExcludedItems] = useState<string[]>(
    s.excludedAssessmentIds,
  );
  const [excludedObjectives, setExcludedObjectives] = useState<string[]>(
    s.excludedObjectiveIds,
  );
  const [kept, setKept] = useState<string[]>(s.protectedEpisodeIds);
  const [preview, setPreview] = useState<{
    key: string;
    blueprint: PlacementBlueprint | null;
  }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  const author = placement.author,
    bounds = placement.authorBounds;
  const episodes = placement.blueprint ?? [];
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x));
  // A changed blueprint or protected unit is checked with the preview before it is saved.
  const scopeChanged =
    !same(excludedItems, s.excludedAssessmentIds) ||
    !same(excludedObjectives, s.excludedObjectiveIds) ||
    !same(kept, s.protectedEpisodeIds);
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
  const input: PlacementSettingsInput = {
    expectedRevision: s.revision,
    enabled,
    retestCooldownHours: Number(cooldown),
    maxRuns: Number(runs),
    maxItems: itemsValue,
    minFamiliesPerEpisode: familiesValue,
    ...(author
      ? {
          excludedAssessmentIds: excludedItems,
          excludedObjectiveIds: excludedObjectives,
          protectedEpisodeIds: kept,
        }
      : {}),
  };
  const key = JSON.stringify(input);
  const submit = () => {
    if (!canSave) return;
    setPending(true);
    setError(undefined);
    port
      .save(catalogId, input)
      .then(onSaved, setError)
      .finally(() => setPending(false));
  };
  const dirty =
    scopeChanged ||
    enabled !== s.enabled ||
    cooldown !== String(s.retestCooldownHours) ||
    runs !== String(s.maxRuns) ||
    itemsValue !== s.maxItems ||
    familiesValue !== s.minFamiliesPerEpisode;
  // A changed blueprint must be checked with the preview first.
  const canSave =
    !pending &&
    dirty &&
    valid &&
    !(scopeChanged && Boolean(port.preview) && preview?.key !== key);
  // Which chapter (required episode) teaches an objective, from the author's blueprint.
  const chapterOf = (objectiveId: string | undefined) =>
    episodes.find((e) =>
      e.objectives.some((o) => o.objectiveId === objectiveId),
    )?.episodeId;
  return (
    <Card title={t("placementView.settings")}>
      <form
        id={`${id}-form`}
        className="input-grid cv-placement-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {author && (
          <div className="wide">
            <Notice tone="blue" title={t("placementView.author.title")}>
              <ul className="plain-list">
                <li>
                  {t("placementView.author.items", {
                    max: placementAuthorLimit(placement) ?? author.maxItems,
                  })}
                </li>
                {bounds?.maxRuns != null && (
                  <li>
                    {t("placementView.author.runs", {
                      runs: bounds.maxRuns,
                      hours: bounds.minCooldownHours ?? 0,
                    })}
                  </li>
                )}
                {bounds?.minFamiliesPerEpisode != null && (
                  <li>
                    {t("placementView.author.families", {
                      families: bounds.minFamiliesPerEpisode,
                    })}
                  </li>
                )}
                {author.assistancePolicy === "unassisted_only" && (
                  <li>{t("placementView.author.unassisted")}</li>
                )}
              </ul>
              <p className="muted">{t("placementView.author.tighten")}</p>
            </Notice>
          </div>
        )}
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
        {author && author.items.length > 0 && (
          <ChoiceGroups
            legend={t("placementView.blueprint.items")}
            hint={t("placementView.blueprint.itemsHint")}
            groups={groupBy(
              author.items.map((item) => ({
                id: item.assessmentId,
                text: item.prompt,
                detail: item.assessmentId,
                episode: chapterOf(item.objectiveIds[0]),
              })),
              episodes,
              t("placementView.group.other"),
            )}
            isOn={(id) => !excludedItems.includes(id)}
            onSet={(ids, on) =>
              setExcludedItems(
                on
                  ? excludedItems.filter((x) => !ids.includes(x))
                  : [...new Set([...excludedItems, ...ids])],
              )
            }
          />
        )}
        {author && author.objectives.length > 0 && (
          <ChoiceGroups
            legend={t("placementView.blueprint.objectives")}
            hint={t("placementView.blueprint.objectivesHint")}
            groups={groupBy(
              author.objectives.map((o) => ({
                id: o.objectiveId,
                text: o.description,
                episode: chapterOf(o.objectiveId),
              })),
              episodes,
              t("placementView.group.other"),
            )}
            isOn={(id) => !excludedObjectives.includes(id)}
            onSet={(ids, on) =>
              setExcludedObjectives(
                on
                  ? excludedObjectives.filter((x) => !ids.includes(x))
                  : [...new Set([...excludedObjectives, ...ids])],
              )
            }
          />
        )}
        {author && episodes.length > 0 && (
          <fieldset className="wide placement-choices">
            <legend>{t("placementView.protect.legend")}</legend>
            <p className="muted">{t("placementView.protect.hint")}</p>
            <div className="cv-choice-columns">
              {episodes.map((episode) => {
                const byAuthor = author.protectedEpisodeIds.includes(
                  episode.episodeId,
                );
                return (
                  <label key={episode.episodeId} className="check-label">
                    <input
                      type="checkbox"
                      checked={byAuthor || kept.includes(episode.episodeId)}
                      disabled={byAuthor}
                      onChange={(e) =>
                        setKept(
                          toggle(kept, episode.episodeId, e.target.checked),
                        )
                      }
                    />
                    <span>
                      <span dir="auto">{episode.title}</span>
                      {byAuthor && (
                        <span className="muted">
                          {" "}
                          · {t("placementView.protect.byAuthor")}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        {preview && preview.key === key && preview.blueprint && (
          <div className="wide">
            <h3 className="section-title">
              {t("placementView.preview.title")}
            </h3>
            <BlueprintTable blueprint={preview.blueprint} />
          </div>
        )}
        <div className="wide stack">
          {error !== undefined && (
            <Notice tone="red">{placementErrorMessage(error, t)}</Notice>
          )}
        </div>
      </form>
      <div className="sticky-actions">
        <div className="button-row">
          <Button
            kind="primary"
            disabled={!canSave}
            onClick={submit}
            aria-describedby={`${id}-why`}
          >
            {t("placementView.form.save")}
          </Button>
          {port.preview && author && (
            <Button
              disabled={pending || !valid}
              onClick={() => {
                setPending(true);
                setError(undefined);
                port.preview!(catalogId, input)
                  .then(
                    (r) => setPreview({ key, blueprint: r.blueprint }),
                    setError,
                  )
                  .finally(() => setPending(false));
              }}
            >
              {t("placementView.preview.run")}
            </Button>
          )}
        </div>
        <p className="button-reason" aria-live="polite" id={`${id}-why`}>
          {!dirty
            ? t("placementView.form.noChanges")
            : !valid
              ? t("placementView.form.invalid")
              : scopeChanged && port.preview && preview?.key !== key
                ? t("placementView.preview.required")
                : t("placementView.form.unsaved")}
        </p>
      </div>
    </Card>
  );
}

type Choice = { id: string; text: string; detail?: string; episode?: string };
type ChoiceGroup = { id: string; title: string; choices: Choice[] };
/** Choices grouped by the chapter that teaches them, in the blueprint's order. */
function groupBy(
  choices: Choice[],
  episodes: PlacementBlueprint,
  other: string,
): ChoiceGroup[] {
  const groups = episodes.map((e) => ({
    id: e.episodeId,
    title: e.title,
    choices: choices.filter((c) => c.episode === e.episodeId),
  }));
  const rest = choices.filter(
    (c) => !c.episode || !episodes.some((e) => e.episodeId === c.episode),
  );
  return [
    ...groups.filter((g) => g.choices.length),
    ...(rest.length ? [{ id: "", title: other, choices: rest }] : []),
  ];
}

/** A long list of checkboxes as one closed group per chapter, each with its count and with
 * "include all" and "leave all out"; open a chapter to change single entries. */
function ChoiceGroups({
  legend,
  hint,
  groups,
  isOn,
  onSet,
}: {
  legend: string;
  hint: string;
  groups: ChoiceGroup[];
  isOn: (id: string) => boolean;
  onSet: (ids: string[], on: boolean) => void;
}) {
  const t = useT();
  const all = groups.flatMap((g) => g.choices.map((c) => c.id));
  const onCount = all.filter(isOn).length;
  return (
    <fieldset className="wide placement-choices cv-choice-groups">
      <legend>{legend}</legend>
      <p className="muted">{hint}</p>
      <div className="cv-group-bar">
        <span className="cv-count">
          {t("placementView.group.total", { on: onCount, total: all.length })}
        </span>
        <Button
          kind="quiet"
          disabled={onCount === all.length}
          onClick={() => onSet(all, true)}
        >
          {t("placementView.group.allOn")}
        </Button>
      </div>
      <ul className="cv-list">
        {groups.map((group) => {
          const ids = group.choices.map((c) => c.id);
          const on = ids.filter(isOn).length;
          return (
            <li key={group.id || "other"}>
              <details className="cv-group">
                <summary>
                  <span className="cv-row-title" dir="auto">
                    {group.title}
                  </span>
                  <Badge
                    tone={on === ids.length ? "green" : on ? "gold" : "neutral"}
                  >
                    {t("placementView.group.count", {
                      on,
                      total: ids.length,
                    })}
                  </Badge>
                  <ChevronDown
                    size={18}
                    aria-hidden="true"
                    className="cv-row-chevron"
                  />
                </summary>
                <div className="cv-row-panel">
                  <div className="cv-actions">
                    <Button
                      kind="quiet"
                      disabled={on === ids.length}
                      onClick={() => onSet(ids, true)}
                    >
                      {t("placementView.group.on")}
                    </Button>
                    <Button
                      kind="quiet"
                      disabled={on === 0}
                      onClick={() => onSet(ids, false)}
                    >
                      {t("placementView.group.off")}
                    </Button>
                  </div>
                  <div className="cv-choice-columns">
                    {group.choices.map((choice) => (
                      <label key={choice.id} className="check-label">
                        <input
                          type="checkbox"
                          checked={isOn(choice.id)}
                          onChange={(e) => onSet([choice.id], e.target.checked)}
                        />
                        <span className="cv-choice-text">
                          <span
                            className="cv-clamp-2"
                            dir="auto"
                            title={choice.text}
                          >
                            {choice.text}
                          </span>
                          {choice.detail && (
                            <small className="mono muted" dir="ltr">
                              {choice.detail}
                            </small>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/** What placement may do with each required episode, in plain words. */
function BlueprintTable({ blueprint }: { blueprint: PlacementBlueprint }) {
  const t = useT();
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label={t("placementView.preview.title")}
    >
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("placementView.preview.episode")}</th>
            <th scope="col">{t("placementView.preview.status")}</th>
            <th scope="col">{t("placementView.preview.questions")}</th>
          </tr>
        </thead>
        <tbody>
          {blueprint.map((episode) => (
            <tr key={episode.episodeId}>
              <td>
                <bdi>{episode.title}</bdi>
              </td>
              <td>
                <Badge
                  tone={
                    episode.status === "placeable"
                      ? "green"
                      : episode.status.startsWith("protected")
                        ? "blue"
                        : "gold"
                  }
                >
                  {t(`placementView.status.${episode.status}` as MessageKey)}
                </Badge>
              </td>
              <td>
                {t("placementView.preview.questionsValue", {
                  questions: episode.questions,
                  families: episode.families,
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnrollmentPlacementPanel({
  port,
  enrollmentId,
  revision,
  canRevoke,
  questionTitle,
}: {
  port: PlacementAdminPort;
  enrollmentId: string;
  revision: number | undefined;
  canRevoke: boolean;
  questionTitle: (assessmentId: string) => string;
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
          questionTitle={questionTitle}
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
  questionTitle,
}: {
  exemption: EnrollmentPlacement["exemptions"][number];
  version: string;
  questionTitle: (assessmentId: string) => string;
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
              assessment: shortTitle(questionTitle(e.assessmentId), 70),
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
