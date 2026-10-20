import { useEffect, useRef, useState } from "react";
import { ProviderModelGuide } from "./ProviderModelGuide";
import { AdminError, errorMessage } from "../domain/errors";
import { evalRequiredSchema, type EvalRequired } from "../domain/providerEvals";
import {
  type ProviderSetupPort,
  type ProviderSetup,
  type ProviderBudgets,
  type Admission,
  usdToMicro,
  microToUsd,
  subscriptionConnections,
  updateSubscriptionFallback,
} from "../domain/providerSetup";
import { Button, Card, Field, Notice } from "./ui";
import { randomId } from "../domain/webCrypto";
interface Props {
  workspaceId: string;
  api: ProviderSetupPort;
  /** Called after a model configuration is saved, so dependent views (prices) can reload. */
  onConfigurationSaved?: () => void;
  /** Called with the revisions a refused save needs evaluated (undefined once a save succeeds). */
  onEvaluationRequired?: (required: EvalRequired | undefined) => void;
}
/** Secrets and unconfirmed payloads exist only in this mounted panel's memory.
 * No local/session storage, raw error rendering or automatic paid request. */
export function ProviderSetupPanel(props: Props) {
  return (
    <Panel
      key={JSON.stringify([props.api.accountId, props.workspaceId])}
      {...props}
    />
  );
}
function Panel({ workspaceId, api, onConfigurationSaved, onEvaluationRequired }: Props) {
  const [saved, setSaved] = useState<ProviderSetup>(),
    [budgets, setBudgets] = useState<ProviderBudgets>(),
    [configuration, setConfiguration] = useState(""),
    [policy, setPolicy] = useState<Admission>(),
    [cost, setCost] = useState("0.100000"),
    [credentialName, setCredentialName] = useState("GOOGLE_API_KEY"),
    [secret, setSecret] = useState(""),
    [removeKey, setRemoveKey] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0),
    explicitReload = useRef(true);
  const [target, setTarget] = useState("workspace"),
    [budgetCost, setBudgetCost] = useState("0.000000"),
    [budgetTokens, setBudgetTokens] = useState("0"),
    [approved, setApproved] = useState(false);
  const pending = useRef<
      | null
      | {
          kind: "configuration";
          input: Parameters<ProviderSetupPort["save"]>[1];
        }
      | {
          kind: "budget";
          input: Parameters<ProviderSetupPort["saveBudget"]>[1];
        }
    >(null),
    writing = useRef(false),
    alive = useRef(true),
    // Budget drafts are seeded from the ledger in the same update that stores
    // it, never from an effect, so a refresh cannot land after the operator
    // started typing. Automatic refreshes keep an edited draft.
    budgetEdited = useRef(false),
    // Ledger revision the draft was seeded from: a preserved draft is still
    // checked against the ledger the operator saw, so a concurrent change is
    // reported as stale instead of silently overwritten.
    budgetBase = useRef<number | undefined>(undefined),
    targetRef = useRef("workspace");
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    void Promise.all([
      api.read(workspaceId, c.signal),
      api.budgets(workspaceId, c.signal),
    ])
      .then(([setup, ledger]) => {
        if (c.signal.aborted) return;
        setSaved(setup);
        applyBudgets(ledger, explicitReload.current);
        explicitReload.current = false;
        setConfiguration(JSON.stringify(setup.configuration, null, 2));
        setPolicy(setup.jobPolicy);
        setCost(microToUsd(setup.jobPolicy.allowance.microUsd));
        setSecret("");
        setRemoveKey(false);
        setError("");
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Secure provider setup is unavailable. The server must enable its protected credential vault.",
          );
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [api, workspaceId, reload]);
  function ledgerFor(ledgers: ProviderBudgets | undefined, scope: string) {
    return scope === "workspace"
      ? ledgers?.workspace
      : ledgers?.enrollments.find((e) => e.enrollmentId === scope);
  }
  /** Stores a ledger. Budget drafts follow it unless the operator edited them
   * and this is an automatic refresh (`discardDraft` false). */
  function applyBudgets(ledgers: ProviderBudgets, discardDraft: boolean) {
    setBudgets(ledgers);
    if (budgetEdited.current && !discardDraft) return;
    const ledger = ledgerFor(ledgers, targetRef.current);
    if (!ledger) return;
    budgetEdited.current = false;
    budgetBase.current = ledger.revision;
    setBudgetCost(microToUsd(ledger.limit_micro_usd));
    setBudgetTokens(ledger.limit_tokens);
    setApproved(false);
  }
  function selectTarget(scope: string) {
    targetRef.current = scope;
    setTarget(scope);
    budgetEdited.current = false;
    const ledger = ledgerFor(budgets, scope);
    budgetBase.current = ledger?.revision;
    if (ledger) {
      setBudgetCost(microToUsd(ledger.limit_micro_usd));
      setBudgetTokens(ledger.limit_tokens);
    }
    setApproved(false);
  }
  async function send() {
    const operation = pending.current;
    if (!operation || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result =
        operation.kind === "configuration"
          ? await api.save(workspaceId, operation.input)
          : await api.saveBudget(workspaceId, operation.input);
      if (!alive.current) return;
      pending.current = null;
      setUncertain(false);
      if (operation.kind === "configuration") setSecret("");
      setApproved(false);
      setNotice(
        operation.kind === "configuration"
          ? `Configuration saved. ${"cancelledPendingJobs" in result ? result.cancelledPendingJobs : 0} unfinished jobs marked for cancellation. Live behavior is still unverified; budgets are unchanged.`
          : "Budget limits saved. Existing usage and reservations are preserved.",
      );
      if (operation.kind === "configuration") {
        onEvaluationRequired?.(undefined);
        explicitReload.current = false;
        setReload((n) => n + 1);
        onConfigurationSaved?.();
      }
      else {
        try {
          const ledger = await api.budgets(workspaceId);
          // The saved draft is now the server value; follow the ledger.
          if (alive.current) applyBudgets(ledger, true);
        } catch {
          if (alive.current)
            setError(
              "Budget limits were saved. Reload saved settings before another budget change.",
            );
        }
      }
    } catch (e) {
      if (!alive.current) return;
      const definitive =
        e instanceof AdminError &&
        [
          "validation",
          "stale_revision",
          "permission_denied",
          "not_found",
          "eval_required",
        ].includes(e.code);
      if (definitive) {
        pending.current = null;
        setUncertain(false);
        if (e instanceof AdminError && e.code === "eval_required") {
          const required = evalRequiredSchema.safeParse(e.details);
          onEvaluationRequired?.(required.success ? required.data : undefined);
          setError(errorMessage(e));
          return;
        }
        setError(
          e instanceof AdminError && e.code === "stale_revision"
            ? "Settings or budget changed. Reload and review before saving again."
            : "The server rejected this change. Check capabilities, admission limits, budget usage and required permissions.",
        );
      } else {
        setUncertain(true);
        setError(
          "The request is unconfirmed. Retry the same request; do not make another change yet.",
        );
      }
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function saveConfiguration() {
    if (!saved || !policy) return;
    try {
      const value = JSON.parse(configuration);
      pending.current = {
        kind: "configuration",
        input: {
          expectedRevision: saved.revision,
          idempotencyKey: randomId(),
          configuration: value,
          jobPolicy: {
            ...policy,
            allowance: { ...policy.allowance, microUsd: usdToMicro(cost) },
          },
          credentials:
            secret || removeKey
              ? { [credentialName]: removeKey ? null : secret }
              : {},
        },
      };
      void send();
    } catch {
      setError(
        "Use valid configuration JSON and a USD allowance with up to six decimal places.",
      );
    }
  }
  function saveBudget() {
    const ledger =
      target === "workspace"
        ? budgets?.workspace
        : budgets?.enrollments.find((e) => e.enrollmentId === target);
    if (!ledger) return;
    try {
      if (!/^\d{1,10}$/.test(budgetTokens) || Number(budgetTokens) > 1000000000)
        throw Error("Enter a whole token limit up to 1,000,000,000.");
      const microUsd = usdToMicro(budgetCost),
        tokens = Number(budgetTokens);
      if ((microUsd || tokens) && !approved) {
        setError(
          "Approve paid work explicitly before saving a positive allowance.",
        );
        return;
      }
      pending.current = {
        kind: "budget",
        input: {
          expectedRevision: budgetBase.current ?? ledger.revision,
          idempotencyKey: randomId(),
          ...(target === "workspace" ? {} : { enrollmentId: target }),
          limits: { microUsd, tokens },
          paidWorkApproved: approved,
        },
      };
      void send();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check budget limits.");
    }
  }
  const disabled = loading || busy || uncertain;
  const subscriptions = subscriptionConnections(configuration);
  return (
    <div className="page-stack">
      <Card title="Connect your AI services" eyebrow="Workspace operator setup">
        <p>
          Choose models and role bindings, store credentials securely, then
          approve paid-work limits separately. Saving settings does not contact
          a model or prove its capabilities.
        </p>
        {loading && <p role="status">Loading secure settings…</p>}
        {error && <Notice tone="red">{error}</Notice>}
        {notice && <Notice tone="blue">{notice}</Notice>}
        {uncertain && (
          <Button onClick={() => void send()} disabled={busy}>
            Retry unconfirmed request
          </Button>
        )}
        {saved && policy && (
          <>
            {api.inspectModels && api.previewModels && (
              <ProviderModelGuide
                workspaceId={workspaceId}
                setup={saved}
                api={api}
                disabled={disabled}
                onConnection={(kind, key) => {
                  try {
                    if (
                      JSON.stringify(JSON.parse(configuration)) !==
                        JSON.stringify(saved.configuration) ||
                      JSON.stringify(policy) !==
                        JSON.stringify(saved.jobPolicy) ||
                      usdToMicro(cost) !== saved.jobPolicy.allowance.microUsd
                    ) {
                      setError(
                        "Save or discard the current model and admission draft before adding another connection.",
                      );
                      return;
                    }
                    const config = JSON.parse(
                      JSON.stringify(saved.configuration),
                    );
                    const id = "connection-" + randomId().slice(0, 8),
                      name =
                        "COURSE_PROVIDER_" +
                        randomId()
                          .replaceAll("-", "")
                          .slice(0, 16)
                          .toUpperCase() +
                        "_API_KEY";
                    config.adapters.push({ id, kind, credentialEnv: name });
                    pending.current = {
                      kind: "configuration",
                      input: {
                        expectedRevision: saved.revision,
                        idempotencyKey: randomId(),
                        configuration: config,
                        jobPolicy: saved.jobPolicy,
                        credentials: { [name]: key },
                      },
                    };
                    void send();
                  } catch {
                    setError(
                      "The connection draft could not be prepared. Refresh the saved settings.",
                    );
                  }
                }}
                onDraft={(preview) => {
                  setConfiguration(
                    JSON.stringify(preview.configuration, null, 2),
                  );
                  setPolicy({
                    ...policy,
                    allowance: {
                      ...policy.allowance,
                      tokens: Math.max(
                        policy.allowance.tokens,
                        preview.minimumTokens,
                      ),
                    },
                  });
                  setNotice(
                    "Model draft prepared. Save settings to activate it; paid budgets and live verification are unchanged.",
                  );
                }}
              />
            )}
            <dl className="facts">
              <div>
                <dt>Saved revision</dt>
                <dd>{saved.revision}</dd>
              </div>
              <div>
                <dt>Live provider verification</dt>
                <dd>Not verified</dd>
              </div>
              <div>
                <dt>Credential storage</dt>
                <dd>Encrypted on the server</dd>
              </div>
            </dl>
            {subscriptions.length > 0 && (
              <fieldset disabled={disabled}>
                <legend>Subscription fallback</legend>
                <p>
                  Choose whether each subscription connection may automatically
                  use paid API access when its allowance is unavailable. Saved
                  paid-work limits still apply. Turning this on does not
                  increase those limits.
                </p>
                {subscriptions.map((connection) => (
                  <div key={connection.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={connection.enabled}
                        onChange={(event) =>
                          setConfiguration(
                            updateSubscriptionFallback(
                              configuration,
                              connection.id,
                              { enabled: event.target.checked },
                            ),
                          )
                        }
                      />
                      Automatically use paid API fallback for {connection.id}
                    </label>
                    {connection.enabled && (
                      <label>
                        Fallback credential reference for {connection.id}
                        <select
                          value={connection.credentialEnv}
                          onChange={(event) =>
                            setConfiguration(
                              updateSubscriptionFallback(
                                configuration,
                                connection.id,
                                { credentialEnv: event.target.value },
                              ),
                            )
                          }
                        >
                          <option value="">
                            Choose a saved server credential
                          </option>
                          {saved.credentials.map((credential) => (
                            <option
                              key={credential.name}
                              value={credential.name}
                            >
                              {credential.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                ))}
                <p>
                  Save settings to apply these choices. Uncertain submitted
                  requests are not automatically duplicated.
                </p>
              </fieldset>
            )}
            <dl className="facts">
              {Object.entries(saved.roles).map(([role, state]) => (
                <div key={role}>
                  <dt>{role} configuration</dt>
                  <dd>
                    {state.status === "ready"
                      ? "Configured · live behavior unverified"
                      : "Not available yet"}
                  </dd>
                </div>
              ))}
            </dl>
            <details
              open={
                !Object.values(saved.roles).some(
                  (role) => role.status === "ready",
                )
              }
            >
              <summary>Models and role bindings</summary>
              <p>
                Use registered server adapters. Google uses kind “google” and
                Anthropic uses kind “anthropic” (text roles only, no media);
                other integrations use a trusted installed adapter. Credentials
                belong in the separate key field below.
              </p>
              <Field
                label="Provider configuration JSON"
                htmlFor="provider-json"
              >
                <textarea
                  id="provider-json"
                  rows={14}
                  maxLength={100000}
                  value={configuration}
                  disabled={disabled}
                  onChange={(e) => setConfiguration(e.target.value)}
                />
              </Field>
            </details>
            <div className="two-column">
              <Field label="Credential binding" htmlFor="provider-key-name">
                <input
                  id="provider-key-name"
                  value={credentialName}
                  disabled={disabled}
                  onChange={(e) => setCredentialName(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="New or replacement API key"
                htmlFor="provider-secret"
              >
                <input
                  id="provider-secret"
                  type="password"
                  autoComplete="new-password"
                  value={secret}
                  disabled={disabled || removeKey}
                  maxLength={8192}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </Field>
            </div>
            <label>
              <input
                type="checkbox"
                checked={removeKey}
                disabled={disabled}
                onChange={(e) => {
                  setRemoveKey(e.target.checked);
                  setSecret("");
                }}
              />{" "}
              Remove this credential binding
            </label>
            <p>
              Stored bindings:{" "}
              {saved.credentials.map((c) => c.name).join(", ") || "None"}.
              Stored values are never returned.
            </p>
            <h3>Per-job admission limits</h3>
            <p>
              These limit each admitted operation. They grant no paid-work
              budget. A model’s configured context and tool rounds must fit
              inside the token allowance.
            </p>
            <div className="two-column">
              <Field label="Per-job cost allowance (USD)" htmlFor="job-cost">
                <input
                  id="job-cost"
                  inputMode="decimal"
                  value={cost}
                  disabled={disabled}
                  onChange={(e) => setCost(e.target.value)}
                />
              </Field>
              <Field label="Per-job token allowance" htmlFor="job-tokens">
                <input
                  id="job-tokens"
                  type="number"
                  min={1}
                  max={1000000000}
                  value={policy.allowance.tokens}
                  disabled={disabled}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      allowance: {
                        ...policy.allowance,
                        tokens: Number(e.target.value),
                      },
                    })
                  }
                />
              </Field>
            </div>
            <p>
              Conservative token bounds in the saved configuration:{" "}
              {Object.entries(saved.tokenBounds)
                .map(([role, bound]) => `${role}: ${bound.toLocaleString()}`)
                .join(" · ") || "No roles configured"}
              .
            </p>
            <div className="two-column">
              <Field label="Job deadline (seconds)" htmlFor="job-deadline">
                <input
                  id="job-deadline"
                  type="number"
                  min={1}
                  max={86400}
                  value={policy.durationMs / 1000}
                  disabled={disabled}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      durationMs: Number(e.target.value) * 1000,
                    })
                  }
                />
              </Field>
              <Field label="Call timeout (seconds)" htmlFor="job-timeout">
                <input
                  id="job-timeout"
                  type="number"
                  min={0.1}
                  max={120}
                  step={0.1}
                  value={policy.timeoutMs / 1000}
                  disabled={disabled}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      timeoutMs: Number(e.target.value) * 1000,
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Maximum attempts" htmlFor="job-attempts">
              <input
                id="job-attempts"
                type="number"
                min={1}
                max={5}
                value={policy.maxAttempts}
                disabled={disabled}
                onChange={(e) =>
                  setPolicy({ ...policy, maxAttempts: Number(e.target.value) })
                }
              />
            </Field>
            <Notice tone="gold">
              Replacing settings cancels unfinished jobs. Calls already sent may
              still finish and incur charges; their accounting is retained.
            </Notice>
            <Button
              kind="primary"
              disabled={disabled}
              onClick={saveConfiguration}
            >
              Save settings and cancel unfinished jobs
            </Button>
          </>
        )}
        <Button
          disabled={busy || uncertain}
          onClick={() => {
            explicitReload.current = true;
            setReload((n) => n + 1);
          }}
        >
          Reload saved settings
        </Button>
      </Card>
      {budgets && (
        <Card
          title="Paid-work allowance"
          eyebrow="Separate workspace and learner budgets"
        >
          <p>
            Both budgets must have room before a call is admitted. Usage
            includes pending reservations, and a budget change cannot erase
            them. These are application allowances, not a provider invoice or
            external billing cap.
          </p>
          <Field label="Budget scope" htmlFor="budget-scope">
            <select
              id="budget-scope"
              value={target}
              disabled={disabled}
              onChange={(e) => selectTarget(e.target.value)}
            >
              <option value="workspace">Entire workspace</option>
              {budgets.enrollments.map((e) => (
                <option key={e.enrollmentId} value={e.enrollmentId}>
                  Enrollment {e.enrollmentId}
                </option>
              ))}
            </select>
          </Field>
          <div className="two-column">
            <Field label="Total cost allowance (USD)" htmlFor="budget-cost">
              <input
                id="budget-cost"
                inputMode="decimal"
                value={budgetCost}
                disabled={disabled}
                onChange={(e) => {
                  budgetEdited.current = true;
                  setBudgetCost(e.target.value);
                }}
              />
            </Field>
            <Field label="Total token allowance" htmlFor="budget-tokens">
              <input
                id="budget-tokens"
                inputMode="numeric"
                value={budgetTokens}
                disabled={disabled}
                onChange={(e) => {
                  budgetEdited.current = true;
                  setBudgetTokens(e.target.value);
                }}
              />
            </Field>
          </div>
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />{" "}
            I authorize paid work within these application limits.
          </label>
          <Button disabled={disabled} onClick={saveBudget}>
            Save paid-work limits
          </Button>
        </Card>
      )}
    </div>
  );
}
