-- Why a quality check stopped on a provider fault, without logs (provider-quality-checks.ts).
--
-- `reason_detail` names the first faulting call: the job (role), Core's provider error code, the
-- provider's HTTP status and its documented reason code (Google's ErrorInfo reason or canonical
-- status, e.g. INVALID_ARGUMENT, RESOURCE_EXHAUSTED). Codes and numbers only: never a response
-- body, message, prompt or key.
ALTER TABLE provider_quality_checks
  ADD COLUMN reason_detail jsonb CHECK(reason_detail IS NULL OR (jsonb_typeof(reason_detail) = 'object' AND length(reason_detail::text) <= 512));
