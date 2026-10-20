import { useState } from "react";
import { PlugZap, ShieldCheck } from "lucide-react";
import type {
  AdminClient,
  CourseWorkspace,
  Provider,
  ProviderConfig,
} from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { ActionFeedback } from "../components/ActionFeedback";
import {ProviderSetupPanel} from "../components/ProviderSetupPanel";
import {ProviderEvalPanel} from "../components/ProviderEvalPanel";
import type {EvalRequired} from "../domain/providerEvals";
import { ProviderCostPanel } from "../components/ProviderCostPanel";
import {RecoveryRegistry} from '../components/RecoveryRegistry';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Notice,
  PermissionHint,
  Status,
} from "../components/ui";

export function ProvidersView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const [selected, setSelected] = useState<Provider>();
  // Saved model configurations change which models can be priced; remount the price panel.
  const [configurations, setConfigurations] = useState(0);
  // Revisions the last refused save needs evaluated; shown in the evaluation panel.
  const [evalRequired, setEvalRequired] = useState<EvalRequired>();
  const canConfigure = data.permissions.includes("provider.configure");
  const costs =
    client.mode === "connected" && canConfigure && data.course.workspaceId && client.providerCosts ? (
      <ProviderCostPanel
        key={configurations}
        workspaceId={data.course.workspaceId}
        api={client.providerCosts}
        accountId={client.providerSetup?.accountId}
      />
    ) : null;
  const evaluations =
    client.mode === "connected" && canConfigure && data.course.workspaceId && client.providerEvals ? (
      <ProviderEvalPanel workspaceId={data.course.workspaceId} api={client.providerEvals} required={evalRequired} reloadKey={configurations} />
    ) : null;
  if(client.mode==="connected"&&canConfigure&&data.course.workspaceId&&client.providerSetup)return <div className="page-stack"><RecoveryRegistry data={data} client={client}/><ProviderSetupPanel workspaceId={data.course.workspaceId} api={client.providerSetup} onConfigurationSaved={()=>setConfigurations((n)=>n+1)} onEvaluationRequired={setEvalRequired}/>{evaluations}{costs}</div>;
  return (
    <div className="page-stack">
      <RecoveryRegistry data={data} client={client}/>
      {costs}
      {client.mode === "connected" &&
        data.permissions.includes("run.inspect") && (
          <Card
            title="Provider/tool accounting"
            eyebrow="Separate from learning deadlines and work caps"
          >
            {data.toolBudget ? (
              <dl className="facts">
                <div>
                  <dt>Token usage / limit</dt>
                  <dd>
                    {data.toolBudget.used_tokens} /{" "}
                    {data.toolBudget.limit_tokens}
                  </dd>
                </div>
                <div>
                  <dt>Cost usage / limit (micro-USD)</dt>
                  <dd>
                    {data.toolBudget.used_micro_usd} /{" "}
                    {data.toolBudget.limit_micro_usd}
                  </dd>
                </div>
              </dl>
            ) : (
              <Notice tone="gold">
                No workspace provider budget has been configured. Configuration
                status alone does not admit paid work.
              </Notice>
            )}
            <small>
              Runtime accounting includes conservative reservations. It does not
              set course deadlines, calendar windows or learning-work caps.
            </small>
          </Card>
        )}
      <ActionFeedback actions={actions} />
      <div className="section-heading">
        <div>
          <h2>Capabilities, with clear boundaries.</h2>
          <p>
            See what can be connected, what is configured and what has actually
            been verified.
          </p>
        </div>
        <span className="large-icon">
          <PlugZap size={28} aria-hidden="true" />
        </span>
      </div>
      <Notice tone="gold">
        Connection requests below contain public metadata only. Authorized workspace operators can use the separate secure setup panel above for credentials and admission limits.
      </Notice>
      <PermissionHint
        permissions={data.permissions}
        required="provider.configure"
      />
      <div className="two-column">
        {data.providers.map((provider) => (
          <Card
            key={provider.id}
            title={provider.name}
            eyebrow="Provider capability slot"
          >
            <p>{provider.description}</p>
            <div className="tag-row">
              {provider.capabilities.map((capability) => (
                <Badge key={capability} tone="blue">
                  {capability}
                </Badge>
              ))}
            </div>
            <dl className="facts vertical">
              <div>
                <dt>Configuration</dt>
                <dd>
                  <Status value={provider.configuration} />
                </dd>
              </div>
              <div>
                <dt>Verification</dt>
                <dd>
                  <Badge
                    tone={
                      provider.verification === "verified"
                        ? "green"
                        : provider.verification === "failed"
                          ? "red"
                          : "gold"
                    }
                  >
                    {provider.verification === "not_run"
                      ? "Not verified"
                      : provider.verification}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt>Connection label</dt>
                <dd>{provider.connectionLabel || "Not set"}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{provider.environment || "Not set"}</dd>
              </div>
            </dl>
            <Notice
              tone={provider.configuration === "absent" ? "gold" : "blue"}
            >
              {provider.detail}
            </Notice>
            <Button
              onClick={() => {
                actions.clear();
                setSelected(provider);
              }}
              disabled={
                !canConfigure ||
                actions.pending ||
                provider.configuration === "pending_review"
              }
            >
              {provider.configuration === "pending_review"
                ? "Configuration review pending"
                : "Request configuration"}
            </Button>
          </Card>
        ))}
      </div>
      <Card
        title="What a verified connection means"
        actions={<ShieldCheck size={22} aria-hidden="true" />}
      >
        <p>
          A server-issued verification result must match the configured
          environment and requested capabilities. A saved label, a submitted
          request or a demo receipt does not establish provider readiness.
        </p>
        <small>
          {client.mode === "demo"
            ? "Demo mode does not contact providers or simulate a successful provider response."
            : "Only the connected backend can attest to a provider result."}
        </small>
      </Card>
      {selected && (
        <Dialog
          title="Request provider configuration"
          onClose={() => setSelected(undefined)}
          pending={actions.pending}
        >
          <ActionFeedback actions={actions} />
          <ConfigForm
            provider={selected}
            pending={actions.pending}
            onSave={async (input) => {
              const result = await actions.run(
                JSON.stringify(["provider", selected.id, input]),
                (ctx) =>
                  client.requestProviderConfig(
                    data.course.id,
                    selected.id,
                    input,
                    ctx,
                  ),
              );
              if (result) setSelected(undefined);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
function ConfigForm({
  provider,
  pending,
  onSave,
}: {
  provider: Provider;
  pending: boolean;
  onSave: (input: ProviderConfig) => void;
}) {
  const [input, setInput] = useState<ProviderConfig>({
    connectionLabel: provider.connectionLabel,
    environment: provider.environment,
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(input);
      }}
    >
      <p>{provider.name}</p>
      <Field
        label="Public connection label"
        htmlFor="provider-label"
        hint="A descriptive label such as Classroom text provider. Do not paste credentials."
      >
        <input
          id="provider-label"
          required
          maxLength={60}
          pattern="[a-zA-Z0-9 _\-]{1,60}"
          value={input.connectionLabel}
          onChange={(e) =>
            setInput({ ...input, connectionLabel: e.target.value })
          }
          disabled={pending}
        />
      </Field>
      <Field
        label="Environment name"
        htmlFor="provider-environment"
        hint="For example, staging. The backend resolves the actual connection."
      >
        <input
          id="provider-environment"
          required
          maxLength={30}
          pattern="[a-zA-Z0-9_\-]{1,30}"
          value={input.environment}
          onChange={(e) => setInput({ ...input, environment: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Notice tone="gold">
        Submitting creates a configuration review request. It does not enable,
        test or verify the provider.
      </Notice>
      <Button type="submit" kind="primary" disabled={pending}>
        {pending ? "Submitting…" : "Submit configuration request"}
      </Button>
    </form>
  );
}
