import { ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { SectionProps } from "./AiServicesPage";
import {
  Field,
  Ltr,
  Message,
  described,
  errorText,
  jobName,
  newKey,
  sectionAnchor,
  useAiText,
} from "./shared";
import { ChangedElsewhere } from "../ChangedElsewhere";
import { useEditableSnapshot } from "../../hooks/useEditableSnapshot";

type Props = SectionProps & { unsaved: boolean };
type Note = { tone: "ok" | "info" | "error"; text: string } | undefined;
interface Adapter {
  id: string;
  kind: string;
  credentialEnv?: string;
  subscriptionRef?: string;
  automaticFallback?: { enabled: boolean; credentialEnv?: string };
}

/** Line and column of a JSON.parse error, when the engine reports a position. */
function jsonError(
  t: ReturnType<typeof useAiText>["t"],
  source: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  const match = /position (\d+)/.exec(message);
  if (!match) return message;
  const before = source.slice(0, Number(match[1])).split("\n");
  return t("aiServices.advanced.jsonPosition", {
    line: before.length,
    column: before.at(-1)!.length + 1,
  });
}

/**
 * For developers: the configuration as JSON (read-only, or edited through the same draft and
 * activation path), raw per-request limits, subscription fallback, other service keys, the
 * rule for unpriced models, and the setup history. Closed by default.
 */
export function AdvancedSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, activate, onDirty } = props;
  const base = useId().replaceAll(":", "");
  const configuration = data.setup.configuration as {
    adapters?: Adapter[];
  } & Record<string, unknown>;
  const pretty = JSON.stringify(configuration, null, 2);
  // Each form here shows the saved values until edited, derived rather than copied in an
  // effect, so an edit made the moment the section appears or while the page reloads is kept,
  // and a change saved elsewhere meanwhile is named instead of overwritten (useEditableSnapshot).
  const [editing, setEditing] = useState(false);
  const jsonEdit = useEditableSnapshot(pretty);
  const json = jsonEdit.value;
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [busy, setBusy] = useState(false);
  const note = (key: string, value: Note) =>
    setNotes((current) => ({ ...current, [key]: value }));
  const policy = data.setup.jobPolicy;
  const initialLimits = {
    cost: String(policy.allowance.microUsd / 1000000),
    tokens: String(policy.allowance.tokens),
    deadline: String(Math.round(policy.durationMs / 60000)),
    timeout: String(Math.round(policy.timeoutMs / 1000)),
    attempts: String(policy.maxAttempts),
  };
  const limitsEdit = useEditableSnapshot(initialLimits);
  const limits = limitsEdit.value;
  const limitsKey = JSON.stringify(initialLimits);
  const [youtube, setYoutube] = useState("");
  const requirePricing = data.pricing?.requirePricing ?? true;
  const ruleEdit = useEditableSnapshot({ require: requirePricing, ack: false });
  const rule = ruleEdit.value;
  const dirty =
    (editing && json !== pretty) ||
    JSON.stringify(limits) !== limitsKey ||
    !!youtube ||
    rule.require !== requirePricing;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  /** Saves a whole configuration and job policy as a draft, then turns it on when no check is
   * needed. Resolves true once the draft is saved. */
  async function apply(
    key: string,
    next: unknown,
    jobPolicy: unknown,
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    setNotes({});
    try {
      const draft = await port.draftFromJson(workspaceId, {
        baseRevision: data.setup.revision,
        configuration: next,
        jobPolicy,
      });
      if (draft.waitingForCheck.length)
        note(key, { tone: "info", text: t("aiServices.advanced.jsonWaiting") });
      else if (await activate(draft)) note(key, { tone: "ok", text: done });
      if (key === "json") {
        setEditing(false);
        jsonEdit.discard();
      } else if (key === "limits") limitsEdit.settle();
      await reload();
      return true;
    } catch (error) {
      note(key, { tone: "error", text: errorText(text, error) });
      return false;
    } finally {
      setBusy(false);
    }
  }
  function saveJson() {
    if (jsonEdit.changedElsewhere) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      note("json", {
        tone: "error",
        text: t("aiServices.advanced.jsonInvalid", {
          message: jsonError(t, json, error),
        }),
      });
      return;
    }
    void apply("json", parsed, policy, t("aiServices.advanced.jsonSaved"));
  }
  function saveLimits() {
    if (limitsEdit.changedElsewhere) return;
    const numbers = {
      cost: Math.round(Number(limits.cost) * 1000000),
      tokens: Number(limits.tokens),
      deadline: Number(limits.deadline),
      timeout: Number(limits.timeout),
      attempts: Number(limits.attempts),
    };
    const ok =
      Number.isInteger(numbers.cost) &&
      numbers.cost >= 1 &&
      numbers.cost <= 1e9 &&
      Number.isInteger(numbers.tokens) &&
      numbers.tokens >= 1 &&
      numbers.tokens <= 1e9 &&
      Number.isInteger(numbers.deadline) &&
      numbers.deadline >= 1 &&
      numbers.deadline <= 1440 &&
      Number.isInteger(numbers.timeout) &&
      numbers.timeout >= 1 &&
      numbers.timeout <= 120 &&
      Number.isInteger(numbers.attempts) &&
      numbers.attempts >= 1 &&
      numbers.attempts <= 5;
    if (!ok) {
      note("limits", {
        tone: "error",
        text: t("aiServices.advanced.limitsInvalid"),
      });
      return;
    }
    void apply(
      "limits",
      configuration,
      {
        allowance: { microUsd: numbers.cost, tokens: numbers.tokens },
        durationMs: numbers.deadline * 60000,
        timeoutMs: numbers.timeout * 1000,
        maxAttempts: numbers.attempts,
      },
      t("aiServices.advanced.limitsSaved"),
    );
  }
  const subscriptions = (configuration.adapters ?? []).filter(
    (a) => a.subscriptionRef,
  );
  const keyed = data.connections.connections
    .map((c) => ({
      c,
      slot: (configuration.adapters ?? []).find((a) => a.id === c.id)
        ?.credentialEnv,
    }))
    .filter((x): x is { c: typeof x.c; slot: string } => !!x.slot);
  async function saveFallback(
    adapterId: string,
    enabled: boolean,
    slot: string,
  ) {
    const next = structuredClone(configuration);
    const adapter = next.adapters!.find((a) => a.id === adapterId)!;
    adapter.automaticFallback = {
      enabled,
      ...(slot ? { credentialEnv: slot } : {}),
    };
    return apply(
      `fallback-${adapterId}`,
      next,
      policy,
      t("aiServices.advanced.jsonSaved"),
    );
  }
  async function serviceKey(value: string | null) {
    setBusy(true);
    note("youtube", undefined);
    try {
      await port.setServiceKey(workspaceId, "youtube", {
        expectedRevision: data.connections.revision,
        idempotencyKey: newKey(),
        key: value,
      });
      setYoutube("");
      note("youtube", {
        tone: "ok",
        text: value
          ? t("aiServices.advanced.serviceKeyStored")
          : t("aiServices.advanced.serviceKeyRemoved"),
      });
      await reload();
    } catch (error) {
      note("youtube", { tone: "error", text: errorText(text, error) });
    } finally {
      setBusy(false);
    }
  }
  async function saveRule() {
    if (!data.pricing || ruleEdit.changedElsewhere) return;
    setBusy(true);
    note("rule", undefined);
    try {
      await port.saveCostSettings(workspaceId, {
        idempotencyKey: newKey(),
        expectedRevision: data.pricing.settingsRevision,
        requirePricing: rule.require,
        ...(rule.require ? {} : { acknowledgeConservativeCharge: rule.ack }),
      });
      note("rule", { tone: "ok", text: t("aiServices.advanced.ruleSaved") });
      ruleEdit.settle();
      await reload();
    } catch (error) {
      note("rule", { tone: "error", text: errorText(text, error) });
    } finally {
      setBusy(false);
    }
  }
  const show = (key: string) => {
    const value = notes[key];
    return value ? <Message tone={value.tone}>{value.text}</Message> : null;
  };
  const youtubeConfigured = data.connections.serviceKeys.find(
    (k) => k.id === "youtube",
  )?.configured;
  const history = [
    ...(data.evals?.results ?? []).map((r) => ({
      at: r.createdAt,
      kind: "result" as const,
      row: r,
    })),
    ...(data.evals?.overrides ?? []).map((o) => ({
      at: o.createdAt,
      kind: "override" as const,
      row: o,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <details id={sectionAnchor("advanced")} className="ai-section ai-advanced">
      <summary>
        <span className="ai-summary-title">
          <ChevronRight
            size={20}
            aria-hidden="true"
            className="ai-chevron flip-rtl"
          />
          <h2>{t("aiServices.section.advanced")}</h2>
        </span>
        {props.unsaved && (
          <span className="ai-pill unsaved">
            {t("aiServices.pill.unsaved")}
          </span>
        )}
      </summary>
      <p>{t("aiServices.advanced.intro")}</p>

      <section className="ai-sub" aria-labelledby={`${base}-config`}>
        <h3 id={`${base}-config`}>{t("aiServices.advanced.configTitle")}</h3>
        <p className="ai-muted">{t("aiServices.advanced.configNote")}</p>
        <p className="ai-muted">
          {t("aiServices.advanced.roleIds", { revision: data.setup.revision })}
        </p>
        {editing ? (
          <Field id={`${base}-json`} label={t("aiServices.advanced.jsonLabel")}>
            <textarea
              id={`${base}-json`}
              dir="ltr"
              className="mono ai-json"
              rows={16}
              spellCheck={false}
              value={json}
              disabled={busy}
              onChange={(event) => jsonEdit.set(event.target.value)}
            />
          </Field>
        ) : (
          <pre
            dir="ltr"
            className="ai-json"
            tabIndex={0}
            aria-label={t("aiServices.advanced.configTitle")}
          >
            {pretty}
          </pre>
        )}
        {show("json")}
        {editing && jsonEdit.changedElsewhere && (
          <ChangedElsewhere
            disabled={busy}
            onShowSaved={jsonEdit.discard}
            onKeep={jsonEdit.keep}
          />
        )}
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(pretty).then(() =>
                note("json", {
                  tone: "ok",
                  text: t("aiServices.advanced.copied"),
                }),
              );
            }}
          >
            {t("aiServices.advanced.copy")}
          </button>
          <label className="ai-check">
            <input
              type="checkbox"
              checked={editing}
              disabled={busy}
              onChange={(event) => {
                setEditing(event.target.checked);
                if (!event.target.checked) jsonEdit.discard();
              }}
            />
            {t("aiServices.advanced.editJson")}
          </label>
          {editing && (
            <button
              type="button"
              className="button primary"
              disabled={busy || jsonEdit.changedElsewhere}
              onClick={saveJson}
            >
              {t("aiServices.advanced.saveJson")}
            </button>
          )}
        </div>
      </section>

      <section className="ai-sub" aria-labelledby={`${base}-limits`}>
        <h3 id={`${base}-limits`}>{t("aiServices.advanced.limitsTitle")}</h3>
        <div className="ai-grid">
          {(
            [
              ["cost", "aiServices.advanced.limitCost", "decimal"],
              ["tokens", "aiServices.advanced.limitTokens", "numeric"],
              ["deadline", "aiServices.advanced.limitDeadline", "numeric"],
              ["timeout", "aiServices.advanced.limitTimeout", "numeric"],
              ["attempts", "aiServices.advanced.limitAttempts", "numeric"],
            ] as const
          ).map(([key, label, mode]) => (
            <Field key={key} id={`${base}-${key}`} label={t(label)}>
              <input
                id={`${base}-${key}`}
                dir="ltr"
                inputMode={mode}
                value={limits[key]}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  limitsEdit.set((current) => ({ ...current, [key]: value }));
                }}
              />
            </Field>
          ))}
        </div>
        {show("limits")}
        {limitsEdit.changedElsewhere && (
          <ChangedElsewhere
            disabled={busy}
            onShowSaved={limitsEdit.discard}
            onKeep={limitsEdit.keep}
          />
        )}
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              JSON.stringify(limits) === limitsKey ||
              limitsEdit.changedElsewhere
            }
            onClick={saveLimits}
          >
            {t("aiServices.advanced.saveLimits")}
          </button>
        </div>
      </section>

      <section className="ai-sub" aria-labelledby={`${base}-fallback`}>
        <h3 id={`${base}-fallback`}>
          {t("aiServices.advanced.fallbackTitle")}
        </h3>
        {subscriptions.length ? (
          subscriptions.map((adapter) => (
            <Fallback
              key={adapter.id}
              adapter={adapter}
              keyed={keyed}
              busy={busy}
              onSave={(enabled, slot) =>
                saveFallback(adapter.id, enabled, slot)
              }
              note={show(`fallback-${adapter.id}`)}
            />
          ))
        ) : (
          <p className="ai-muted">{t("aiServices.advanced.fallbackNone")}</p>
        )}
      </section>

      <section className="ai-sub" aria-labelledby={`${base}-service`}>
        <h3 id={`${base}-service`}>
          {t("aiServices.advanced.serviceKeysTitle")}
        </h3>
        <Field
          id={`${base}-youtube`}
          label={t("aiServices.advanced.youtube")}
          hint={`${t("aiServices.advanced.youtubeHint")} ${youtubeConfigured ? t("aiServices.advanced.serviceSaved") : t("aiServices.advanced.serviceNotSaved")}.`}
        >
          <input
            id={`${base}-youtube`}
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={8192}
            value={youtube}
            disabled={busy}
            onChange={(event) => setYoutube(event.target.value)}
            {...described(`${base}-youtube`, true, undefined)}
          />
        </Field>
        {show("youtube")}
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !youtube.trim()}
            onClick={() => void serviceKey(youtube.trim())}
          >
            {t("aiServices.advanced.saveServiceKey")}
          </button>
          {youtubeConfigured && (
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void serviceKey(null)}
            >
              {t("aiServices.advanced.removeServiceKey")}
            </button>
          )}
        </div>
      </section>

      <section className="ai-sub" aria-labelledby={`${base}-rule`}>
        <h3 id={`${base}-rule`}>{t("aiServices.advanced.pricingRuleTitle")}</h3>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={rule.require}
            disabled={busy}
            onChange={(event) =>
              ruleEdit.set({ require: event.target.checked, ack: false })
            }
          />
          {t("aiServices.advanced.requirePricing")}
        </label>
        {!rule.require && (
          <label className="ai-check">
            <input
              type="checkbox"
              checked={rule.ack}
              disabled={busy}
              onChange={(event) => {
                const ack = event.target.checked;
                ruleEdit.set((current) => ({ ...current, ack }));
              }}
            />
            {t("aiServices.advanced.requirePricingAck")}
          </label>
        )}
        {show("rule")}
        {ruleEdit.changedElsewhere && (
          <ChangedElsewhere
            disabled={busy}
            onShowSaved={ruleEdit.discard}
            onKeep={ruleEdit.keep}
          />
        )}
        <div className="ai-actions">
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              ruleEdit.changedElsewhere ||
              rule.require === requirePricing ||
              (!rule.require && !rule.ack)
            }
            onClick={() => void saveRule()}
          >
            {t("aiServices.advanced.saveRule")}
          </button>
        </div>
      </section>

      <section className="ai-sub" aria-labelledby={`${base}-history`}>
        <h3 id={`${base}-history`}>{t("aiServices.advanced.historyTitle")}</h3>
        <p className="ai-muted">{t("aiServices.advanced.cli")}</p>
        {history.length ? (
          <ul className="ai-list">
            {history.map((item) => (
              <li key={item.row.id}>
                {item.kind === "result"
                  ? t("aiServices.advanced.historyResult", {
                      job: jobName(t, item.row.role),
                      outcome: t(
                        item.row.outcome === "passed"
                          ? "aiServices.advanced.outcome.passed"
                          : "aiServices.advanced.outcome.failed",
                      ),
                      date: text.date(item.at),
                    })
                  : t("aiServices.advanced.historyOverride", {
                      job: jobName(t, item.row.role),
                      date: text.date(item.at),
                    })}
                {item.kind === "override" && "reason" in item.row && (
                  <>
                    <br />
                    <span className="ai-muted" dir="auto">
                      {t("aiServices.advanced.historyReason", {
                        reason: item.row.reason,
                      })}
                    </span>
                  </>
                )}
                <br />
                <span className="ai-muted">
                  {t("aiServices.advanced.fingerprint")}:{" "}
                  <Ltr className="mono">
                    {item.row.revisionDigest.slice(0, 16)}
                  </Ltr>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ai-muted">{t("aiServices.advanced.historyEmpty")}</p>
        )}
      </section>
    </details>
  );
}

function Fallback({
  adapter,
  keyed,
  busy,
  onSave,
  note,
}: {
  adapter: Adapter;
  keyed: {
    c: { id: string; name: string; label: string; kind: string };
    slot: string;
  }[];
  busy: boolean;
  onSave: (enabled: boolean, slot: string) => Promise<boolean>;
  note: React.ReactNode;
}) {
  const { t } = useAiText();
  const base = useId().replaceAll(":", "");
  const edit = useEditableSnapshot({
    enabled: adapter.automaticFallback?.enabled === true,
    slot: adapter.automaticFallback?.credentialEnv ?? "",
  });
  const { enabled, slot } = edit.value;
  return (
    <div className="ai-form">
      <label className="ai-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => {
            const enabled = event.target.checked;
            edit.set((current) => ({ ...current, enabled }));
          }}
        />
        {t("aiServices.advanced.fallbackLabel", { name: adapter.id })}
      </label>
      <Field id={`${base}-slot`} label={t("aiServices.advanced.fallbackKey")}>
        <select
          id={`${base}-slot`}
          value={slot}
          disabled={busy}
          onChange={(event) => {
            const slot = event.target.value;
            edit.set((current) => ({ ...current, slot }));
          }}
        >
          <option value="">{t("aiServices.advanced.fallbackChoose")}</option>
          {keyed.map(({ c, slot: value }) => (
            <option key={value} value={value}>
              {(c.kind === "google" || c.kind === "anthropic"
                ? t(`aiServices.kind.${c.kind}`)
                : c.label) + (c.name ? ` · ${c.name}` : "")}
            </option>
          ))}
        </select>
      </Field>
      {note}
      {edit.changedElsewhere && (
        <ChangedElsewhere
          disabled={busy}
          onShowSaved={edit.discard}
          onKeep={edit.keep}
        />
      )}
      <div className="ai-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy || (enabled && !slot) || edit.changedElsewhere}
          onClick={() =>
            void onSave(enabled, slot).then((saved) => saved && edit.settle())
          }
        >
          {t("aiServices.advanced.saveFallback")}
        </button>
      </div>
    </div>
  );
}
