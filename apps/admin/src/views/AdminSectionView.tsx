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
  when,
} from "../components/ui";

const scopeLabels: Record<SectionScope, string> = {
  course: "Whole course",
  chapter: "One chapter",
  enrollment: "One learner",
};
const accessLabels: Record<SectionView["learnerDataAccess"], string> = {
  none: "Uses no learner data.",
  aggregate:
    "Declares aggregate learner data. Core shares none with this section.",
  scoped_with_consent:
    "Asks for learner data with consent. There is no learner sharing control yet, so Core shares none.",
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
  const [scope, setScope] = useState<SectionScope>("course");
  const [scopeRef, setScopeRef] = useState("");
  const [saved, setSaved] = useState("");
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
    return <Loading label="Loading course settings…" />;
  if (course.error || !course.data)
    return <Notice tone="red">{adminSectionErrorMessage(course.error)}</Notice>;
  const header = course.data.section,
    section = view.data?.section;
  const scopes = header.scopes;
  return (
    <div className="page-stack">
      <div aria-live="polite">
        {saved && <Notice tone="green">{saved}</Notice>}
      </div>
      <Card
        title={header.title}
        eyebrow={`Declared by release ${course.data.release.version} · section ${header.version}`}
      >
        {header.description && <p>{header.description}</p>}
        <div className="tag-row">
          <Badge tone="blue">
            Rendered by Core from the course's settings schema
          </Badge>
          {header.renderer.declaredRendererRef && (
            <Badge>
              Custom renderer {header.renderer.declaredRendererRef} not loaded
            </Badge>
          )}
        </div>
        <p className="muted">
          {accessLabels[header.learnerDataAccess]} Every change is recorded in
          the audit log.
        </p>
      </Card>
      {scopes.length > 1 && (
        <Card title="Where the settings apply">
          <nav aria-label="Setting level" className="segmented">
            {scopes.map((s) => (
              <Button
                key={s}
                kind={scope === s ? "primary" : "quiet"}
                aria-pressed={scope === s}
                onClick={() => {
                  setScope(s);
                  setScopeRef("");
                  setSaved("");
                }}
              >
                {scopeLabels[s]}
              </Button>
            ))}
          </nav>
          {scope === "chapter" && (
            <Field label="Chapter" htmlFor={`${id}-chapter`}>
              <select
                id={`${id}-chapter`}
                value={scopeRef}
                onChange={(e) => {
                  setScopeRef(e.target.value);
                  setSaved("");
                }}
              >
                <option value="">Choose a chapter</option>
                {list.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {scope === "enrollment" &&
            (data.permissions.includes("enrollment.read") ? (
              <Field label="Learner" htmlFor={`${id}-learner`}>
                <select
                  id={`${id}-learner`}
                  value={scopeRef}
                  onChange={(e) => {
                    setScopeRef(e.target.value);
                    setSaved("");
                  }}
                >
                  <option value="">Choose a learner</option>
                  {learners.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.profile.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Notice tone="gold">
                Your role cannot open learners' enrollments, so learner-level
                settings are not available to you.
              </Notice>
            ))}
        </Card>
      )}
      {view.error ? (
        <Notice tone="red">{adminSectionErrorMessage(view.error)}</Notice>
      ) : !ready ? (
        <EmptyState title="Choose where to look">
          Pick a {scope === "chapter" ? "chapter" : "learner"} to see its
          settings.
        </EmptyState>
      ) : view.loading || !section ? (
        <Loading label="Loading course settings…" />
      ) : (
        <SettingsForm
          key={`${section.scope}:${section.scopeRef}:${section.revision}`}
          port={port}
          catalogId={data.course.id}
          section={section}
          onSaved={(next) => {
            setSaved(`${next.title} saved (revision ${next.revision}).`);
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
    editable.map((s) => [s.id, settingProblem(s, values[s.id]!)]),
  );
  const valid = changed.every((s) => problems[s.id] === null);
  if (!section.settings.length)
    return (
      <EmptyState title="No settings at this level">
        This section declares no settings here.
      </EmptyState>
    );
  return (
    <Card
      title="Settings"
      actions={
        <small className="mono">
          revision {section.revision}
          {section.updatedAt ? ` · ${when(section.updatedAt)}` : ""}
        </small>
      }
    >
      {!editable.length && (
        <Notice tone="gold">
          Read only: your role cannot change these settings.
        </Notice>
      )}
      <form
        className="input-grid"
        aria-label={`${section.title} settings`}
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
              <Notice tone="red">{adminSectionErrorMessage(error)}</Notice>
            )}
            <Button
              kind="primary"
              type="submit"
              disabled={pending || !changed.length || !valid}
            >
              Save {section.title}
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
  const hint = [
    setting.description,
    setting.type === "integer" || setting.type === "number"
      ? `${setting.minimum} to ${setting.maximum}.`
      : null,
    setting.type === "string" ? `Up to ${setting.maxLength} characters.` : null,
    setting.source === "default"
      ? `Default: ${String(setting.default)}.`
      : null,
    setting.discardedSavedValue
      ? "The saved value no longer fits this release and is not used."
      : null,
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
          {setting.label}
        </label>
        {hint && <small className="muted">{hint}</small>}
      </div>
    );
  return (
    <Field label={setting.label} htmlFor={id} hint={hint}>
      {setting.type === "enum" ? (
        <select
          id={id}
          value={String(value)}
          disabled={!setting.canEdit}
          onChange={(e) => onChange(e.target.value)}
        >
          {setting.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : setting.type === "string" ? (
        <input
          id={id}
          type="text"
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
    </Field>
  );
}
