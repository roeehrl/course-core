import { useEffect, useRef, useState } from "react";
import {
  costErrorMessage,
  isDefinitive,
  isoToLocal,
  localToIso,
  usd,
  usdField,
  type PriceInput,
  type PriceVersion,
  type PricingView,
  type ProviderCostPort,
  type SpendSums,
  type SpendView,
} from "../domain/providerCosts";
import { Badge, Button, Card, Field, Notice } from "./ui";
import { randomId } from "../domain/webCrypto";

interface Props {
  workspaceId: string;
  api: ProviderCostPort;
  accountId?: string | undefined;
}
const PER_MILLION_MAX = 1_000_000_000,
  PER_UNIT_MAX = 100_000_000;
/** Pricing drafts and unconfirmed writes live only in this mounted panel. */
export function ProviderCostPanel(props: Props) {
  return (
    <Panel key={JSON.stringify([props.accountId, props.workspaceId])} {...props} />
  );
}
type Pending =
  | { kind: "price"; input: PriceInput }
  | {
      kind: "settings";
      input: Parameters<ProviderCostPort["saveSettings"]>[1];
    };
function money(value: string | number) {
  return `$${usd(value)}`;
}
function priceSummary(v: PriceVersion) {
  if (v.status === "withdrawn") return "Withdrawn: no price from this time.";
  const parts: string[] = [];
  if (v.inputMicroUsdPerMillionTokens !== null)
    parts.push(`input ${money(v.inputMicroUsdPerMillionTokens)} per 1M tokens`);
  if (v.cachedInputMicroUsdPerMillionTokens !== null)
    parts.push(`cached input ${money(v.cachedInputMicroUsdPerMillionTokens)} per 1M tokens`);
  if (v.outputMicroUsdPerMillionTokens !== null)
    parts.push(`output ${money(v.outputMicroUsdPerMillionTokens)} per 1M tokens`);
  if (v.microUsdPerRequest !== null)
    parts.push(`${money(v.microUsdPerRequest)} per request`);
  if (v.microUsdPerOutputSecond !== null)
    parts.push(`${money(v.microUsdPerOutputSecond)} per output second`);
  if (v.microUsdPerServerToolRequest !== null && v.microUsdPerServerToolRequest !== undefined)
    parts.push(`${money(v.microUsdPerServerToolRequest)} per web search`);
  return parts.join(" · ");
}
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Panel({ workspaceId, api }: Props) {
  const [view, setView] = useState<PricingView>(),
    [spend, setSpend] = useState<SpendView>(),
    [period, setPeriod] = useState<"day" | "month">("day"),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const [requirePricing, setRequirePricing] = useState(true),
    [acknowledged, setAcknowledged] = useState(false);
  const [modelId, setModelId] = useState(""),
    [input, setInput] = useState(""),
    [cached, setCached] = useState(""),
    [output, setOutput] = useState(""),
    [request, setRequest] = useState(""),
    [second, setSecond] = useState(""),
    [search, setSearch] = useState(""),
    [effective, setEffective] = useState(() => isoToLocal(new Date().toISOString())),
    [source, setSource] = useState("");
  const pending = useRef<Pending | null>(null),
    writing = useRef(false),
    alive = useRef(true);
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
    void api
      .pricing(workspaceId, c.signal)
      .then((loaded) => {
        if (c.signal.aborted) return;
        setView(loaded);
        setRequirePricing(loaded.requirePricing);
        setAcknowledged(false);
        setModelId((current) =>
          loaded.models.some((m) => m.modelId === current)
            ? current
            : (loaded.models.find((m) => m.configured)?.modelId ?? ""),
        );
      })
      .catch(() => {
        if (!c.signal.aborted)
          setError("Model prices could not be loaded. Reload to try again.");
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [api, workspaceId, reload]);
  useEffect(() => {
    const c = new AbortController();
    void api
      .spend(workspaceId, period, c.signal)
      .then((loaded) => {
        if (!c.signal.aborted) setSpend(loaded);
      })
      .catch(() => {
        if (!c.signal.aborted) setSpend(undefined);
      });
    return () => c.abort();
  }, [api, workspaceId, period, reload]);
  async function send() {
    const operation = pending.current;
    if (!operation || writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (operation.kind === "price") {
        const result = await api.savePrice(workspaceId, operation.input);
        if (!alive.current) return;
        setNotice(
          result.status === "withdrawn"
            ? `Price withdrawn for ${result.modelId} (version ${result.version}). Calls admitted from ${when(result.effectiveFrom)} are unpriced.`
            : `Price version ${result.version} saved for ${result.modelId}. ${result.inForceNow ? "It prices calls admitted from now on." : `It takes effect ${when(result.effectiveFrom)}.`} Calls already admitted keep their price.`,
        );
        setSource("");
      } else {
        const result = await api.saveSettings(workspaceId, operation.input);
        if (!alive.current) return;
        setNotice(
          result.requirePricing
            ? "Paid work now needs a price for the model it uses."
            : "Unpriced models may be used; each such call keeps the full per-job allowance as its charge.",
        );
      }
      pending.current = null;
      setUncertain(false);
      setReload((n) => n + 1);
    } catch (e) {
      if (!alive.current) return;
      if (isDefinitive(e)) {
        pending.current = null;
        setUncertain(false);
        setError(costErrorMessage(e));
      } else {
        setUncertain(true);
        setError("The request is unconfirmed. Retry the same request; do not make another change yet.");
      }
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const selected = view?.models.find((m) => m.modelId === modelId);
  function savePrice(status: "active" | "withdrawn") {
    if (!selected) return;
    try {
      const prices =
        status === "withdrawn"
          ? { inputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null, microUsdPerServerToolRequest: null }
          : {
              inputMicroUsdPerMillionTokens: usdField(input, PER_MILLION_MAX),
              cachedInputMicroUsdPerMillionTokens: usdField(cached, PER_MILLION_MAX),
              outputMicroUsdPerMillionTokens: usdField(output, PER_MILLION_MAX),
              microUsdPerRequest: usdField(request, PER_UNIT_MAX),
              microUsdPerOutputSecond: usdField(second, PER_UNIT_MAX),
              microUsdPerServerToolRequest: usdField(search, PER_UNIT_MAX),
            };
      if (status === "active") {
        if ((prices.inputMicroUsdPerMillionTokens === null) !== (prices.outputMicroUsdPerMillionTokens === null))
          throw Error("Enter both the input and the output price per million tokens, or neither.");
        if (prices.cachedInputMicroUsdPerMillionTokens !== null && prices.inputMicroUsdPerMillionTokens === null)
          throw Error("A cached-input price needs an input price.");
        if (prices.inputMicroUsdPerMillionTokens === null && prices.microUsdPerRequest === null && prices.microUsdPerOutputSecond === null)
          throw Error("Enter at least one price.");
      }
      const note = source.trim();
      if (note.length < 3) throw Error("Say where these prices come from, for example the provider pricing page and the date you read it.");
      pending.current = {
        kind: "price",
        input: {
          idempotencyKey: randomId(),
          modelId: selected.modelId,
          expectedVersion: selected.latestVersion,
          status,
          currency: "USD",
          ...prices,
          effectiveFrom: localToIso(effective),
          sourceNote: note,
        },
      };
      void send();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check the prices.");
    }
  }
  function saveRule() {
    if (!view) return;
    if (!requirePricing && !acknowledged) {
      setError("Confirm that unpriced calls keep the full per-job allowance as their charge.");
      return;
    }
    pending.current = {
      kind: "settings",
      input: {
        idempotencyKey: randomId(),
        expectedRevision: view.settingsRevision,
        requirePricing,
        ...(requirePricing ? {} : { acknowledgeConservativeCharge: true }),
      },
    };
    void send();
  }
  const disabled = loading || busy || uncertain;
  return (
    <div className="page-stack">
      <Card title="Model prices" eyebrow="Entered by you · no built-in vendor prices">
        <p>
          Each call’s cost is the provider’s reported token counts times the
          price version in force when the call was admitted, rounded up to a
          whole micro-dollar. Copy prices from your provider’s current pricing
          page and note where they came from. A new version never reprices
          calls already admitted.
        </p>
        {loading && <p role="status">Loading model prices…</p>}
        {error && <Notice tone="red">{error}</Notice>}
        {notice && <Notice tone="blue">{notice}</Notice>}
        {uncertain && (
          <Button onClick={() => void send()} disabled={busy}>
            Retry unconfirmed pricing request
          </Button>
        )}
        {view && (
          <>
            <fieldset className="cost-rule" disabled={disabled}>
              <legend>Unpriced models</legend>
              <label>
                <input
                  type="checkbox"
                  checked={requirePricing}
                  onChange={(e) => {
                    setRequirePricing(e.target.checked);
                    setAcknowledged(false);
                  }}
                />{" "}
                Refuse paid work for models without a price (recommended)
              </label>
              {!requirePricing && (
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />{" "}
                  I accept that each unpriced call keeps the full per-job
                  allowance as its charge, with no refund of the unused part.
                </label>
              )}
              <Button
                onClick={saveRule}
                disabled={disabled || requirePricing === view.requirePricing}
              >
                Save pricing rule
              </Button>
            </fieldset>
            {view.models.length === 0 && (
              <Notice tone="gold">
                No models are configured yet. Save a model configuration
                first; then enter its prices here.
              </Notice>
            )}
            <div className="price-models">
              {view.models.map((model, index) => {
                const priced = model.coverage.length > 0 && model.coverage.every((c) => c.priced);
                return (
                  <section
                    key={model.modelId}
                    className="price-model"
                    aria-labelledby={`price-model-${index}`}
                  >
                    <h3 id={`price-model-${index}`}>{model.modelId}</h3>
                    <div className="tag-row">
                      {model.roles.map((role) => (
                        <Badge key={role} tone="blue">{role}</Badge>
                      ))}
                      {model.roles.length === 0 && <Badge>No role bound</Badge>}
                      {model.roles.length > 0 && (
                        <Badge tone={priced ? "green" : view.requirePricing ? "red" : "gold"}>
                          {priced
                            ? "Priced"
                            : view.requirePricing
                              ? "No price: paid work refused"
                              : "No price: charged the full allowance"}
                        </Badge>
                      )}
                    </div>
                    <p>
                      {model.inForce
                        ? `In force since ${when(model.inForce.effectiveFrom)} (version ${model.inForce.version}): ${priceSummary(model.inForce)}`
                        : "No price in force."}
                    </p>
                    {model.inForce && model.inForce.status === "active" && (
                      <p className="price-source">Source: {model.inForce.sourceNote}</p>
                    )}
                    {model.coverage.some((c) => c.priced && c.serverToolsUnpriced) && (
                      <p className="price-source">
                        No web search price. Providers that bill each search separately (Anthropic does) leave a research
                        call that searched unpriced, so it keeps its full allowance.
                      </p>
                    )}
                    {model.history.length > 0 && (
                      <details>
                        <summary>Version history ({model.history.length})</summary>
                        <div className="table-wrap" tabIndex={0} role="region" aria-label={`Price history for ${model.modelId}`}>
                          <table>
                            <thead>
                              <tr>
                                <th scope="col">Version</th>
                                <th scope="col">Effective</th>
                                <th scope="col">Prices</th>
                                <th scope="col">Source</th>
                              </tr>
                            </thead>
                            <tbody>
                              {model.history.map((v) => (
                                <tr key={v.id}>
                                  <td>{v.version}</td>
                                  <td>{when(v.effectiveFrom)}</td>
                                  <td>{priceSummary(v)}</td>
                                  <td>{v.sourceNote}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </section>
                );
              })}
            </div>
            {view.models.length > 0 && (
              <form
                className="stack price-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  savePrice("active");
                }}
              >
                <h3>Add a price version</h3>
                <fieldset disabled={disabled}>
                  <Field label="Model to price" htmlFor="price-model">
                    <select id="price-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                      {view.models.map((m) => (
                        <option key={m.modelId} value={m.modelId}>
                          {m.modelId}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="two-column">
                    <Field label="Input price per 1M tokens (USD)" htmlFor="price-input" hint="Text, images and tool prompts sent to the model.">
                      <input id="price-input" inputMode="decimal" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} />
                    </Field>
                    <Field label="Output price per 1M tokens (USD)" htmlFor="price-output" hint="Includes thinking tokens.">
                      <input id="price-output" inputMode="decimal" autoComplete="off" value={output} onChange={(e) => setOutput(e.target.value)} />
                    </Field>
                    <Field label="Cached input price per 1M tokens (USD)" htmlFor="price-cached" hint="Optional. Empty uses the input price.">
                      <input id="price-cached" inputMode="decimal" autoComplete="off" value={cached} onChange={(e) => setCached(e.target.value)} />
                    </Field>
                    <Field label="Price per request (USD)" htmlFor="price-request" hint="Optional, added to every billed call.">
                      <input id="price-request" inputMode="decimal" autoComplete="off" value={request} onChange={(e) => setRequest(e.target.value)} />
                    </Field>
                    <Field label="Price per generated video second (USD)" htmlFor="price-second" hint="Generated media only.">
                      <input id="price-second" inputMode="decimal" autoComplete="off" value={second} onChange={(e) => setSecond(e.target.value)} />
                    </Field>
                    <Field label="Price per web search (USD)" htmlFor="price-search" hint="Optional. For providers that bill each research web search separately, such as Anthropic.">
                      <input id="price-search" inputMode="decimal" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
                    </Field>
                    <Field label="Takes effect" htmlFor="price-effective" hint="Your local time. Not earlier than the version it replaces.">
                      <input id="price-effective" type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} />
                    </Field>
                  </div>
                  <Field label="Where these prices come from" htmlFor="price-source" hint="For example the provider pricing page and the date you read it.">
                    <input id="price-source" maxLength={500} autoComplete="off" value={source} onChange={(e) => setSource(e.target.value)} />
                  </Field>
                  <div className="button-row">
                    <Button type="submit" kind="primary" disabled={disabled || !selected}>
                      Save price version
                    </Button>
                    {selected?.inForce?.status === "active" && (
                      <Button type="button" kind="danger" disabled={disabled} onClick={() => savePrice("withdrawn")}>
                        Withdraw this model’s price
                      </Button>
                    )}
                  </div>
                </fieldset>
              </form>
            )}
          </>
        )}
      </Card>
      <SpendCard spend={spend} period={period} onPeriod={setPeriod} />
    </div>
  );
}
function SumCells({ row }: { row: SpendSums }) {
  return (
    <>
      <td>{row.calls}</td>
      <td>{money(row.reserved)}</td>
      <td>{money(row.charged)}</td>
      <td>{money(row.actual)}</td>
      <td>{money(row.released)}</td>
      <td>{money(row.held)}</td>
    </>
  );
}
function SumHead({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th scope="col">{first}</th>
        <th scope="col">Calls</th>
        <th scope="col">Reserved</th>
        <th scope="col">Charged now</th>
        <th scope="col">Actual (priced)</th>
        <th scope="col">Released</th>
        <th scope="col">Held</th>
      </tr>
    </thead>
  );
}
function SpendCard({ spend, period, onPeriod }: { spend: SpendView | undefined; period: "day" | "month"; onPeriod: (p: "day" | "month") => void }) {
  return (
    <Card title="Paid-work spend" eyebrow="Reserved at admission, reconciled after each call">
      <p>
        Each call reserves its full per-job allowance. When the provider
        reports usage and the model is priced, the actual cost is charged and
        the rest returns to the workspace and learner budgets. Calls in flight,
        with an unknown outcome or without a price keep the full reservation.
        These are application figures, not a provider invoice.
      </p>
      <Field label="Group spend by" htmlFor="spend-period">
        <select id="spend-period" value={period} onChange={(e) => onPeriod(e.target.value as "day" | "month")}>
          <option value="day">Day (last 30 days, UTC)</option>
          <option value="month">Month (last 12 months, UTC)</option>
        </select>
      </Field>
      {!spend ? (
        <p role="status">Loading spend…</p>
      ) : (
        <>
          <dl className="facts spend-totals">
            <div><dt>Reserved</dt><dd>{money(spend.totals.reserved)}</dd></div>
            <div><dt>Charged now</dt><dd>{money(spend.totals.charged)}</dd></div>
            <div><dt>Actual (priced calls)</dt><dd>{money(spend.totals.actual)}</dd></div>
            <div><dt>Released back</dt><dd>{money(spend.totals.released)}</dd></div>
            <div><dt>Held for calls in flight or uncertain</dt><dd>{money(spend.totals.held)}</dd></div>
            <div><dt>Unpriced, charged in full</dt><dd>{money(spend.totals.unpriced)}</dd></div>
          </dl>
          {spend.totals.calls === 0 ? (
            <Notice tone="blue">No paid calls in this period.</Notice>
          ) : (
            <>
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Spend by period">
                <table>
                  <caption>By {period === "day" ? "day" : "month"}</caption>
                  <SumHead first={period === "day" ? "Day" : "Month"} />
                  <tbody>
                    {spend.byPeriod.map((row) => (
                      <tr key={row.period}><th scope="row">{row.period}</th><SumCells row={row} /></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Spend by role">
                <table>
                  <caption>By role</caption>
                  <SumHead first="Role" />
                  <tbody>
                    {spend.byRole.map((row) => (
                      <tr key={row.role}><th scope="row">{row.role}</th><SumCells row={row} /></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Spend by enrollment">
                <table>
                  <caption>By enrollment (highest charge first)</caption>
                  <SumHead first="Enrollment" />
                  <tbody>
                    {spend.byEnrollment.map((row) => (
                      <tr key={row.enrollmentId}><th scope="row"><code>{row.enrollmentId}</code></th><SumCells row={row} /></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </Card>
  );
}
