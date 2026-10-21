/**
 * User-visible text of the provider setup surface: adding and testing keys, key bindings and
 * the reasons a key test or a metadata inspection failed. English only for now. Every string
 * this surface adds lives here, so moving it to shared message catalogs is mechanical.
 */
export const providerSetupText = {
  keyHint:
    "Paste the key as issued. Spaces and line breaks around it are removed.",
  testKey: "Test key",
  testingKey: "Testing key…",
  testExplanation:
    "Test key asks the provider for its model list with this key. Nothing is generated, no learner data is sent, and the key is not stored until you save.",
  savedKeyCheck:
    "To check a key that is already saved, choose its connection in step 2 and inspect model metadata.",
  untestedWarning:
    "This key has not passed a test. You can still save it, but testing first shows now whether the key is wrong or restricted.",
  keyWorks: (count: number, truncated: boolean) =>
    `The key works: the provider listed ${count.toLocaleString()} models${truncated ? " (the list was cut at the host limit)" : ""}. Only model metadata was read.`,
  testIncomplete:
    "The key test did not complete. Check your connection and try again.",
  replaceKeyHeading: "Enter the key again for this connection",
  replaceKeyLabel: (connection: string) => `New API key for ${connection}`,
  replaceKeySave: "Save key for this connection",
  replaceKeySaved:
    "Key saved for this connection. Inspect model metadata to check it.",
  bindingTarget: "Key applies to",
  bindingExplanation:
    "A key is stored under the binding name of its connection. Choose the connection, and the binding name below follows it.",
  bindingConnection: (provider: string, id: string) =>
    `${provider} connection ${id}`,
  bindingFallback: (id: string) => `Paid API fallback of ${id}`,
  bindingStored: (name: string) => `Stored binding ${name}`,
  bindingOther: "Another binding name",
  inspectionFailed:
    "Metadata inspection failed or its scope changed. Check the saved connection and refresh before another inspection.",
} as const;

/** What to tell the operator for each reason a key test, an inspection or a key save was
 * refused. A code without an entry falls back to the caller's general message. */
const reasons: Record<string, string> = {
  PROVIDER_METADATA_CREDENTIAL_MISSING:
    "No key is stored for this connection. Enter the key again and save.",
  PROVIDER_METADATA_CREDENTIAL_MALFORMED:
    "The stored key contains spaces, line breaks or characters an API key never has. Copy the key again from the provider's console, without any surrounding text, enter it again and save.",
  PROVIDER_METADATA_KEY_INVALID:
    "The provider says this key is not valid: it may be mistyped, deleted or expired. Copy the key again from the provider's console (for Google, Google AI Studio), or create a new one, then test it again.",
  PROVIDER_METADATA_API_NOT_ENABLED:
    "The key is valid, but the API is not enabled for its project. For Google, enable the Generative Language API in the key's Google Cloud project (keys created in Google AI Studio have it enabled), wait a few minutes, then test again.",
  PROVIDER_METADATA_KEY_RESTRICTED:
    "The key's restrictions block this API. In the provider's console, allow the Generative Language API for Google keys, or remove website or app restrictions that exclude this server, then test again.",
  PROVIDER_METADATA_PERMISSION_DENIED:
    "The provider refused permission for this key. Check that the key's project or organization can use this API and that its restrictions allow this server, then test again.",
  PROVIDER_METADATA_RATE_LIMITED:
    "The provider reports a quota or rate limit for this key. Wait a minute and try again, or check the project's quota and billing in the provider's console.",
  PROVIDER_METADATA_REJECTED:
    "The provider refused the request. The service may be unavailable in this region, or the project's billing may not be set up. Check the project in the provider's console.",
  PROVIDER_METADATA_UPSTREAM_ERROR:
    "The provider reported a server error. Try again in a few minutes.",
  PROVIDER_METADATA_NETWORK:
    "This server could not reach the provider. Check the server's internet connection, proxy or firewall, then try again.",
  PROVIDER_METADATA_TIMEOUT:
    "The provider did not answer in time. Try again; if this keeps happening, check the server's network.",
  PROVIDER_METADATA_INVALID:
    "The provider's answer was not a model list this host accepts. Try again later.",
  PROVIDER_METADATA_TOO_LARGE:
    "The provider's model list was larger than this host accepts. Try again later.",
  PROVIDER_METADATA_UNSUPPORTED:
    "This provider has no installed metadata check, so its key cannot be tested or inspected here.",
  PROVIDER_METADATA_UNAVAILABLE:
    "The metadata check failed for an unexpected reason. Try again; nothing was saved or charged.",
  PROVIDER_METADATA_SCOPE_CHANGED:
    "Saved settings or your access changed during the inspection. Reload saved settings, then inspect again.",
  PROVIDER_METADATA_INTERRUPTED:
    "The inspection was interrupted before it finished. Inspect again.",
  PROVIDER_METADATA_BUSY:
    "Other inspections are still running for this workspace. Wait a moment, then inspect again.",
  PROVIDER_CREDENTIAL_EMPTY:
    "Enter an API key. A key cannot be empty or only spaces.",
  PROVIDER_CREDENTIAL_MALFORMED:
    "This key contains spaces, line breaks or characters an API key never has. Copy the key again from the provider's console, without any surrounding text.",
  PROVIDER_KEY_TEST_RATE_LIMITED:
    "Too many key tests for this workspace in a short time. Wait a minute, then test again.",
  PROVIDER_KEY_TEST_INVALID:
    "The key test request was not accepted. Reload the page and try again.",
};
export function reasonMessage(code: string | null | undefined) {
  return code && Object.hasOwn(reasons, code) ? reasons[code] : undefined;
}
/** Reasons that mean the stored key itself needs replacing. */
export const keyReasons: ReadonlySet<string> = new Set([
  "PROVIDER_METADATA_CREDENTIAL_MISSING",
  "PROVIDER_METADATA_CREDENTIAL_MALFORMED",
  "PROVIDER_METADATA_KEY_INVALID",
  "PROVIDER_METADATA_API_NOT_ENABLED",
  "PROVIDER_METADATA_KEY_RESTRICTED",
  "PROVIDER_METADATA_PERMISSION_DENIED",
]);
