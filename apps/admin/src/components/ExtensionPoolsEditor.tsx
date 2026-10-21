import type {
  ExtensionPoolConfig,
  PolicySettingsView,
} from "../domain/policyLedger";
import { Badge, Button, Field, Notice } from "./ui";
import { useFormatters, useI18n, type MessageKey } from "../i18n";

type Coverage = NonNullable<
  NonNullable<PolicySettingsView["preview"]>["pools"]
>;
const UNITS = ["calendar_day", "planned_minute", "episode"] as const;
const PLACES = ["course", "every_chapter", "every_episode"] as const;

/** "Extra time and work allowances": pools an administrator adds on top of what the course
 * release declares, and an optional last date no extension can pass. Shown inside the course
 * policy settings, so they are previewed and saved with the same review and reason. */
export function ExtensionPoolsEditor({
  pools,
  ultimateDeadline,
  canWrite,
  coverage,
  onChange,
}: {
  pools: ExtensionPoolConfig[];
  ultimateDeadline: string | null;
  canWrite: boolean;
  /** The reviewed preview's pool coverage; absent until the draft is previewed. */
  coverage: Coverage | undefined;
  onChange: (
    pools: ExtensionPoolConfig[],
    ultimateDeadline: string | null,
  ) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const set = (index: number, patch: Partial<ExtensionPoolConfig>) =>
    onChange(
      pools.map((pool, i) => (i === index ? { ...pool, ...patch } : pool)),
      ultimateDeadline,
    );
  const fresh = (): ExtensionPoolConfig => {
    let n = pools.length + 1;
    while (pools.some((p) => p.id === `allowance-${n}`)) n++;
    return {
      id: `allowance-${n}`,
      unit: "calendar_day",
      appliesTo: "every_chapter",
      sharing: "shared",
      total: 4,
      maxPerGrant: 2,
      maxGrants: 2,
    };
  };
  /** Places this allowance can never be used, summed over its pools in the preview. */
  const unusable = (id: string) => {
    const rows = (coverage ?? []).filter(
      (row) =>
        row.source === "admin" &&
        (row.poolId === `admin:${id}` || row.poolId.startsWith(`admin:${id}:`)),
    );
    return {
      places: rows.reduce((n, row) => n + row.scopeIds.length, 0),
      blocked: rows.reduce((n, row) => n + row.unusableScopeIds.length, 0),
    };
  };
  const local = ultimateDeadline ? ultimateDeadline.slice(0, 16) : "";
  return (
    <fieldset className="stack" disabled={!canWrite}>
      <legend>{t("extensionPoolsEditor.title")}</legend>
      <p>{t("extensionPoolsEditor.intro")}</p>
      {!pools.length && <small>{t("extensionPoolsEditor.empty")}</small>}
      {pools.map((pool, index) => {
        const prefix = `pool-${index}`;
        const check = unusable(pool.id);
        const tooLarge = pool.maxPerGrant > pool.total;
        return (
          <div className="record stack" key={index}>
            <div className="split-line">
              <h3>
                {t("extensionPoolsEditor.pool", {
                  name: pool.id,
                })}
              </h3>
              <Badge tone="blue">
                {t(`extensionPoolsEditor.unit.${pool.unit}` as MessageKey)}
              </Badge>
            </div>
            <div className="input-grid">
              <Field
                label={t("extensionPoolsEditor.name")}
                htmlFor={`${prefix}-id`}
                hint={t("extensionPoolsEditor.name.hint")}
              >
                <input
                  id={`${prefix}-id`}
                  dir="ltr"
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9-]*"
                  value={pool.id}
                  onChange={(e) =>
                    set(index, { id: e.target.value.toLowerCase() })
                  }
                />
              </Field>
              <Field
                label={t("extensionPoolsEditor.unit")}
                htmlFor={`${prefix}-unit`}
              >
                <select
                  id={`${prefix}-unit`}
                  value={pool.unit}
                  onChange={(e) =>
                    set(index, {
                      unit: e.target.value as ExtensionPoolConfig["unit"],
                    })
                  }
                >
                  {UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`extensionPoolsEditor.unit.${unit}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={t("extensionPoolsEditor.appliesTo")}
                htmlFor={`${prefix}-applies`}
              >
                <select
                  id={`${prefix}-applies`}
                  value={pool.appliesTo}
                  onChange={(e) =>
                    set(index, {
                      appliesTo: e.target
                        .value as ExtensionPoolConfig["appliesTo"],
                    })
                  }
                >
                  {PLACES.map((place) => (
                    <option key={place} value={place}>
                      {t(
                        `extensionPoolsEditor.appliesTo.${place}` as MessageKey,
                      )}
                    </option>
                  ))}
                </select>
              </Field>
              {pool.appliesTo !== "course" && (
                <Field
                  label={t("extensionPoolsEditor.sharing")}
                  htmlFor={`${prefix}-sharing`}
                  hint={t(
                    `extensionPoolsEditor.sharing.${pool.sharing}.hint` as MessageKey,
                  )}
                >
                  <select
                    id={`${prefix}-sharing`}
                    value={pool.sharing}
                    onChange={(e) =>
                      set(index, {
                        sharing: e.target
                          .value as ExtensionPoolConfig["sharing"],
                      })
                    }
                  >
                    <option value="shared">
                      {t("extensionPoolsEditor.sharing.shared")}
                    </option>
                    <option value="per_scope">
                      {t("extensionPoolsEditor.sharing.per_scope")}
                    </option>
                  </select>
                </Field>
              )}
              <Field
                label={t("extensionPoolsEditor.total")}
                htmlFor={`${prefix}-total`}
              >
                <input
                  id={`${prefix}-total`}
                  type="number"
                  min={1}
                  value={pool.total}
                  onChange={(e) =>
                    set(index, { total: Number(e.target.value) })
                  }
                />
              </Field>
              <Field
                label={t("extensionPoolsEditor.maxPerGrant")}
                htmlFor={`${prefix}-per-grant`}
                {...(tooLarge
                  ? { hint: t("extensionPoolsEditor.maxPerGrant.tooLarge") }
                  : {})}
              >
                <input
                  id={`${prefix}-per-grant`}
                  type="number"
                  min={1}
                  value={pool.maxPerGrant}
                  aria-invalid={tooLarge || undefined}
                  onChange={(e) =>
                    set(index, { maxPerGrant: Number(e.target.value) })
                  }
                />
              </Field>
              <Field
                label={t("extensionPoolsEditor.maxGrants")}
                htmlFor={`${prefix}-grants`}
              >
                <input
                  id={`${prefix}-grants`}
                  type="number"
                  min={1}
                  max={100}
                  value={pool.maxGrants}
                  onChange={(e) =>
                    set(index, { maxGrants: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            <small>
              {t("extensionPoolsEditor.summary", {
                total: pool.total,
                perGrant: pool.maxPerGrant,
                grants: pool.maxGrants,
                unit: pool.unit,
                place: pool.appliesTo,
                sharing: pool.appliesTo === "course" ? "shared" : pool.sharing,
              })}
            </small>
            {coverage && check.blocked > 0 && (
              <Notice tone="gold">
                {t(
                  pool.unit === "calendar_day"
                    ? "extensionPoolsEditor.unusable.days"
                    : "extensionPoolsEditor.unusable.work",
                  { blocked: check.blocked, places: check.places },
                )}
              </Notice>
            )}
            {coverage && check.places === 0 && (
              <Notice tone="gold">{t("extensionPoolsEditor.noPlaces")}</Notice>
            )}
            <div>
              <Button
                type="button"
                onClick={() =>
                  onChange(
                    pools.filter((_, i) => i !== index),
                    ultimateDeadline,
                  )
                }
              >
                {t("extensionPoolsEditor.remove")}
              </Button>
            </div>
          </div>
        );
      })}
      {pools.length < 10 && (
        <div>
          <Button
            type="button"
            onClick={() => onChange([...pools, fresh()], ultimateDeadline)}
          >
            {t("extensionPoolsEditor.add")}
          </Button>
        </div>
      )}
      <Field
        label={t("extensionPoolsEditor.ultimate")}
        htmlFor="settings-ultimate"
        hint={t("extensionPoolsEditor.ultimate.hint")}
      >
        <input
          id="settings-ultimate"
          type="datetime-local"
          value={local}
          onChange={(e) =>
            onChange(
              pools,
              e.target.value
                ? new Date(`${e.target.value}:00Z`).toISOString()
                : null,
            )
          }
        />
      </Field>
      {ultimateDeadline && (
        <small>
          {t("extensionPoolsEditor.ultimate.value", {
            date: when(ultimateDeadline),
          })}
        </small>
      )}
    </fieldset>
  );
}
