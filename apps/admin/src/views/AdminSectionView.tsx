import { useId, useState } from "react";
import type { CourseWorkspace } from "../domain/contracts";
import {
  adminSectionErrorMessage,
  settingProblem,
  settingValue,
  type AdminSectionList,
  type AdminSectionsPort,
  type AdminSectionView as SectionView,
  type SectionScope,
  type SectionSetting,
} from "../domain/adminSections";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useT, type MessageKey } from "../i18n";

const scopeKeys: Record<SectionScope, MessageKey> = {
  course: "adminSectionView.scope.course",
  chapter: "adminSectionView.scope.chapter",
  enrollment: "adminSectionView.scope.enrollment",
};
const accessKeys: Record<SectionView["learnerDataAccess"], MessageKey> = {
  none: "adminSectionView.access.none",
  aggregate: "adminSectionView.access.aggregate",
  scoped_with_consent: "adminSectionView.access.scoped_with_consent",
};

/**
 * One admin section declared by the live course release, rendered by Core from its settings
 * schema. The server decides visibility and edit rights; this form only reflects them.
 */
export function AdminSectionView({
  port,
  data,
  sectionId,
  list,
}: {
  port: AdminSectionsPort;
  data: CourseWorkspace;
  sectionId: string;
  list: AdminSectionList;
}) {
  const id = useId();
  const t = useT();
  const [scope, setScope] = useState<SectionScope>("course");
  const [scopeRef, setScopeRef] = useState("");
  const [saved, setSaved] = useState<{
    title: string;
    revision: number;
  } | null>(null);
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  const ready = scope === "course" || scopeRef !== "";
  // The course level carries the section's description and levels; other levels load beside it.
  const course = useRemote(
    (signal) =>
      port.read(
        data.course.id,
        sectionId,
        { scope: "course", scopeRef: "" },
        signal,
      ),
    [port, data.course.id, sectionId],
  );
  const other = useRemote(
    (signal) =>
      scope !== "course" && ready
        ? port.read(data.course.id, sectionId, { scope, scopeRef }, signal)
        : Promise.resolve(null),
    [port, data.course.id, sectionId, scope, scopeRef],
  );
  const view = scope === "course" ? course : other;
  if (course.loading && !course.data)
    return <Loading label={t("adminSectionView.loading")} />;
  if (course.error || !course.data)
    return (
      <Notice tone="red">{adminSectionErrorMessage(course.error, t)}</Notice>
    );
  const header = course.data.section,
    section = view.data?.section;
  const scopes = header.scopes;
  return (
    <div className="page-stack">
      <div aria-live="polite">
        {saved && (
          <Notice tone="green">
            {t("adminSectionView.saved", {
              title: saved.title,
              revision: saved.revision,
            })}
          </Notice>
        )}
      </div>
      <Card
        title={header.title}
        titleDir="auto"
        eyebrow={t("adminSectionView.declaredBy", {
          release: course.data.release.version,
          version: header.version,
        })}
      >
        {header.description && <p dir="auto">{header.description}</p>}
        <div className="tag-row">
          <Badge tone="blue">{t("adminSectionView.renderedByCore")}</Badge>
          {header.renderer.declaredRendererRef && (
            <Badge>
              {t("adminSectionView.customRenderer", {
                ref: header.renderer.declaredRendererRef,
              })}
            </Badge>
          )}
        </div>
        <p className="muted">
          {t(accessKeys[header.learnerDataAccess])}{" "}
          {t("adminSectionView.audited")}
        </p>
      </Card>
      {scopes.length > 1 && (
        <Card title={t("adminSectionView.levels.title")}>
          <nav
            aria-label={t("adminSectionView.levels.label")}
            className="segmented"
          >
            {scopes.map((s) => (
              <Button
                key={s}
                kind={scope === s ? "primary" : "quiet"}
                aria-pressed={scope === s}
                onClick={() => {
                  setScope(s);
                  setScopeRef("");
                  setSaved(null);
                }}
              >
                {t(scopeKeys[s])}
              </Button>
            ))}
          </nav>
          {scope === "chapter" && (
            <Field
              label={t("adminSectionView.chapter")}
              htmlFor={`${id}-chapter`}
            >
              <select
                id={`${id}-chapter`}
                value={scopeRef}
                onChange={(e) => {
                  setScopeRef(e.target.value);
                  setSaved(null);
                }}
              >
                <option value="">{t("adminSectionView.chooseChapter")}</option>
                {list.chapters.map((c) => (
                  <option key={c.id} value={c.id} dir="auto">
                    {c.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {scope === "enrollment" &&
            (data.permissions.includes("enrollment.read") ? (
              <Field
                label={t("adminSectionView.learner")}
                htmlFor={`${id}-learner`}
              >
                <select
                  id={`${id}-learner`}
                  value={scopeRef}
                  onChange={(e) => {
                    setScopeRef(e.target.value);
                    setSaved(null);
                  }}
                >
                  <option value="">
                    {t("adminSectionView.chooseLearner")}
                  </option>
                  {learners.map((e) => (
                    <option key={e.id} value={e.id} dir="auto">
                      {e.profile.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Notice tone="gold">
                {t("adminSectionView.noLearnerAccess")}
              </Notice>
            ))}
        </Card>
      )}
      {view.error ? (
        <Notice tone="red">{adminSectionErrorMessage(view.error, t)}</Notice>
      ) : !ready ? (
        <EmptyState title={t("adminSectionView.choose.title")}>
          {scope === "chapter"
            ? t("adminSectionView.choose.chapter")
            : t("adminSectionView.choose.learner")}
        </EmptyState>
      ) : view.loading || !section ? (
        <Loading label={t("adminSectionView.loading")} />
      ) : (
        <SettingsForm
          key={`${section.scope}:${section.scopeRef}:${section.revision}`}
          port={port}
          catalogId={data.course.id}
          section={section}
          onSaved={(next) => {
            setSaved({ title: next.title, revision: next.revision });
            view.reload();
          }}
        />
      )}
    </div>
  );
}

function SettingsForm({
  port,
  catalogId,
  section,
  onSaved,
}: {
  port: AdminSectionsPort;
  catalogId: string;
  section: SectionView;
  onSaved: (section: SectionView) => void;
}) {
  const id = useId();
  const t = useT();
  const { when } = useFormatters();
  const initial = Object.fromEntries(
    section.settings.map((s) => [
      s.id,
      s.type === "boolean" ? s.value : String(s.value),
    ]),
  ) as Record<string, string | boolean>;
  const [values, setValues] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const editable = section.settings.filter((s) => s.canEdit);
  const changed = editable.filter((s) => values[s.id] !== initial[s.id]);
  const problems = Object.fromEntries(
    editable.map((s) => [s.id, settingProblem(s, values[s.id]!, t)]),
  );
  const valid = changed.every((s) => problems[s.id] === null);
  if (!section.settings.length)
    return (
      <EmptyState title={t("adminSectionView.noSettings.title")}>
        {t("adminSectionView.noSettings.body")}
      </EmptyState>
    );
  return (
    <Card
      title={t("adminSectionView.settings")}
      actions={
        <small className="mono">
          {section.updatedAt
            ? t("adminSectionView.revisionAt", {
                revision: section.revision,
                date: when(section.updatedAt),
              })
            : t("adminSectionView.revision", { revision: section.revision })}
        </small>
      }
    >
      {!editable.length && (
        <Notice tone="gold">{t("adminSectionView.readOnly")}</Notice>
      )}
      <form
        className="input-grid"
        aria-label={t("adminSectionView.formLabel", { title: section.title })}
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          port
            .save(catalogId, section.id, {
              scope: section.scope,
              scopeRef: section.scopeRef,
              expectedRevision: section.revision,
              values: Object.fromEntries(
                changed.map((s) => [s.id, settingValue(s, values[s.id]!)]),
              ),
            })
            .then((r) => onSaved(r.section), setError)
            .finally(() => setPending(false));
        }}
      >
        {section.settings.map((s) => (
          <SettingInput
            key={s.id}
            id={`${id}-${s.id}`}
            setting={s}
            value={values[s.id]!}
            problem={problems[s.id] ?? null}
            onChange={(v) =>
              setValues((current) => ({ ...current, [s.id]: v }))
            }
          />
        ))}
        {!!editable.length && (
          <div className="wide stack">
            {error !== undefined && (
              <Notice tone="red">{adminSectionErrorMessage(error, t)}</Notice>
            )}
            <Button
              kind="primary"
              type="submit"
              disabled={pending || !changed.length || !valid}
            >
              {t("adminSectionView.save", { title: section.title })}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function SettingInput({
  id,
  setting,
  value,
  problem,
  onChange,
}: {
  id: string;
  setting: SectionSetting;
  value: string | boolean;
  problem: string | null;
  onChange: (value: string | boolean) => void;
}) {
  const t = useT();
  const hint = [
    setting.description,
    setting.type === "integer" || setting.type === "number"
      ? t("adminSectionView.hint.range", {
          min: setting.minimum,
          max: setting.maximum,
        })
      : null,
    setting.type === "string"
      ? t("adminSectionView.hint.maxLength", { max: setting.maxLength })
      : null,
    setting.source === "default"
      ? t("adminSectionView.hint.default", { value: String(setting.default) })
      : null,
    setting.discardedSavedValue ? t("adminSectionView.hint.discarded") : null,
    setting.canEdit && problem ? problem : null,
  ]
    .filter(Boolean)
    .join(" ");
  if (setting.type === "boolean")
    return (
      <div className="wide">
        <label className="check-label">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={!setting.canEdit}
            onChange={(e) => onChange(e.target.checked)}
          />
          <bdi>{setting.label}</bdi>
        </label>
        {hint && <small className="muted">{hint}</small>}
      </div>
    );
  return (
    // The same markup as Field, with the course-declared label isolated as course text.
    <div className="field">
      <label htmlFor={id} dir="auto">
        {setting.label}
      </label>
      {setting.type === "enum" ? (
        <select
          id={id}
          value={String(value)}
          disabled={!setting.canEdit}
          onChange={(e) => onChange(e.target.value)}
        >
          {setting.options.map((o) => (
            <option key={o} value={o} dir="auto">
              {o}
            </option>
          ))}
        </select>
      ) : setting.type === "string" ? (
        <input
          id={id}
          type="text"
          dir="auto"
          value={String(value)}
          maxLength={setting.maxLength}
          disabled={!setting.canEdit}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!problem}
        />
      ) : (
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={setting.minimum}
          max={setting.maximum}
          step={setting.type === "integer" ? 1 : "any"}
          value={String(value)}
          disabled={!setting.canEdit}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!problem}
        />
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
