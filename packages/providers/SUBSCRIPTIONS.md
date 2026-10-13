# Subscription-backed adapters

`subscriptionAdapter` is a generic server-side wrapper around the same capability
ports used by API-backed adapters. It is not a provider login implementation.
Only implement a connector where the provider documents subscription access for
third-party applications. A consumer chat subscription or an OAuth token alone is
not sufficient. No Google consumer subscription connector is installed.

An integration supplies a non-secret, host-bound `subscriptionRef`, documented
application-access approval, a fresh status reader, and an atomic `authorize`
function. Native transport, sign-in/refresh, secure credential custody, provider
quota/idempotency and entitlement verification belong to the trusted connector.
Neither course bundles nor browser JSON can install code or approve access.

The status contract covers expiry, renewal windows and quota hints. Unknown
remaining allowance stays null. Hints do not reserve quota: before every native
call the connector must authorize the exact account, model, operation and stable
accounting key with an unexpired entitlement revision. Included-only permission
must be enforced at the remote billing boundary. The wrapper checks this binding
and rejects stale, mismatched, expired or extra-charge grants before dispatch.

## Optional automatic fallback

`automaticFallback` defaults off. An enabled policy supplies an API-backed adapter
with the same logical provider/model identifiers and a separate host authorization
function. That function must recheck saved user opt-in, scopes, credential access,
current cost/token limits and a durable reservation before returning approval.
Turning fallback on is not permission to increase a budget. Unknown prices still
need conservative reservation; subscription access never invents zero-cost usage.

Only failed subscription admission can start fallback. An uncertain submitted
request, invalid output or cancellation never triggers another model call. Both
routes share the original timeout. Usage keeps the actual token/attempt receipt,
cost remains unknown, and `usage.access` identifies subscription access or the
fallback authorization and reason. The durable host still owns retries, quota
settlement, lost acknowledgements and reconciliation.

Video jobs preserve an explicit route across submit, poll and cancel. Subscription
recovery does not move a paid pending job, and quota exhaustion does not move an
existing subscription job. `accessRoute` is routing data, not proof of ownership;
the host and connector must validate job access. Disabling fallback stops new
automatic fallback operations, including automatic polling on that route, until
the user explicitly chooses an authorized continuation.

## Core configuration

API adapters retain `credentialEnv`. Subscription adapters use `subscriptionRef`
instead; a configuration with both or neither is rejected. A future trusted
factory receives `options.subscription.reference` and the saved fallback policy.
It must return an adapter whose subscription binding and fallback mode match the
configuration. With opt-in, the fallback credential reference is separate:

```json
{
  "id": "teaching-provider",
  "kind": "installed-supported-subscription-provider",
  "subscriptionRef": "host-connection-1",
  "automaticFallback": {
    "enabled": true,
    "credentialEnv": "COURSE_PROVIDER_TEACHING_API_KEY"
  }
}
```

The reference contains no login material. Admin setup offers per-connection
opt-in/out and saved fallback-credential selection; explicit save, revision checks
and current budgets still apply. The generic wrapper does not authenticate an
actual provider, prove its terms/capabilities/pricing or constitute live acceptance.
Tests use synthetic connectors alongside actual Core routing, Postgres and
responsive browser forms; no real paid calls are made.
