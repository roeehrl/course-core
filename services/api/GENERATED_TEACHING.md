# Novel teaching through course-owned verification

The supervisor can generate new explanation or practice text, instead of only
selecting an existing reviewed bank entry. Generation is a proposal. It does not
grant mastery, supply proof, authorize expense or change a course's standards.

The flow is:

1. The learner enables course-scoped adaptive teaching.
2. `list_generation_profiles` exposes only approved profiles for the current
   episode whose exact adapter implementation is installed.
3. `create_teaching` receives bounded Markdown, objective IDs and existing source
   IDs. The host assigns artifact identity, generator version, registry and
   permission revisions. The tool stores a candidate receipt without a lesson write.
4. A separate verification phase matches the actual scoped receipt and runs the
   installed course verifier. All required checks and evidence references must
   pass for the exact artifact digest.
5. Atomic delivery repeats that verifier and checks current consent, registry,
   enrollment, episode availability, independent-assessment exclusion and every
   ancestor quota/deadline. The SDK validates the proposal and the host records
   real proof and assignment receipts. Failure rolls back the whole lesson write.
6. A delivery retry returns the existing receipt. It does not duplicate the
   lesson, its work accounting or its mastery evidence.

The learner reads the new material in the normal linear lesson. The optional
supervisor timeline and operator inspector show candidate/delivery metadata;
pre-delivery text is withheld. A selected tool call is shown as delivered only
when its exact candidate matches the applied plan.

## Creator and operator integration

Use the released SDK's `GeneratorDeclaration`, `VerifierDeclaration`,
`ArtifactVerifierPort` and ordinary explanation/practice `TeachingArtifact`
contracts. Declare the target episode, objectives, source references, allowed
operation, required checks and expansion limits in the course manifest.

In trusted server composition, install a `TrustedAdaptationAdapter` with
`kind: 'generated-teaching'`, an exact implementation fingerprint, a mandatory
`validateProfile` function and `createPorts` returning its registered independent
verifier. The verifier must match the course declaration, extension integrity and
owner-approved adaptation registry. A generated-teaching profile uses
`append_teaching` and cannot contain a reviewed bank, a numerical recipe or a
canonical grading-key selection. Its time and required/optional classification
come from the approved registry, never from the model.

Pass the resulting `createAdaptationRuntime` to `createServer`. Existing
`approveAdaptationRegistry` applies the normal scoped owner/admin approval.
The stock CLI now supports explicitly installed isolated verifier definitions.
It still provides no arbitrary JavaScript module loader or universal factual
verifier. A capability string alone does not install executable code.

## Isolated creator programs

An operator can set `TEACHING_VERIFIER_FILES` to a JSON array of owned definition
file paths. The native pilot uses the equivalent `teachingVerifierFiles` array in
its private configuration. Files must be regular, singly linked, owned by the
operator, private to that owner and at most 256 KiB. They go only to the API
process; worker, dispatcher and Temporal processes do not receive the programs.

Each definition is a separate server artifact, never embedded in a learner
bundle. Its fields are:

| Field | Purpose |
| --- | --- |
| `schemaVersion: 1` | Versioned definition format. |
| `id`, `version` | Server extension identity/version. |
| `adapterId`, `generatorId`, `verifierId` | Exact course and registry bindings. |
| `artifactKinds`, `sourceRefs`, `checkIds` | Supported teaching and independent checks. |
| `source` | A Python `solve(payload)` verifier, at most 64 KiB. |
| `referenceData` | Creator-owned independent reference data, at most 32 KiB. |
| `qualification` | Four to sixteen SDK artifact/expected-check examples, including at least two distinct valid examples and two distinct invalid examples. |

Build each qualification artifact with the released SDK's
`digestTeachingArtifact`; use `expectedChecks` containing exactly the declared
check IDs and boolean expected outcomes. Repeating content under different IDs
does not count as independent coverage. Definitions with missing checks,
inconsistent identity/digests or one-sided coverage are rejected before execution.

`solve` receives the artifact, reference data, required check IDs and the host's
base-course/proposal digests. It returns an object mapping every check ID to a
boolean. The broker compares that complete result with the expected checks.
Qualification executes both correct and incorrect reference cases; programs that
always return true or always return false fail installation.

The installed adapter fingerprint is SHA-256 of the entire definition file.
Pin that fingerprint in the generator/verifier extension and owner-approved
adaptation profile. Changing program bytes, reference data or qualification
examples changes identity and requires a new matching approval. An installed
program does not authorize itself to teach a course or change its grading.

Programs run in the prepared digest-pinned Python image with no network, a
read-only filesystem, no host credentials, 128 MiB memory, 0.5 CPU, one broker
execution at a time, and the existing time/output/process bounds. Qualification
and every candidate verification execute outside the application process. An
unavailable or unhealthy broker installs no teaching capability. No automatic
image pull, package installation or provider call is authorized by this feature.
More languages/dependencies need explicit separately qualified runtimes.

Local verifiers must be bounded independent reference/content checks. They can
also consume an already authenticated external review receipt. This application
hook does not authorize unaccounted provider calls. Domain-specific factual,
numerical and pedagogical validity belongs in the verifier: successful schema
validation, a cited source ID or agreement from another model is insufficient.

For executable activities, images, video, research attachments, new episodes,
branches and undo, the broader artifact/dispatch/application work is still
required; this text-generation path does not establish their completion.

## Qualification and its limits

The public ordering fixture verifies the *entire* grammar of a novel worked
example using an independent membership/order reference. It accepts varied,
correct examples and rejects plausible wrong answers or unsupported appended
claims. It is deliberately not a truth checker for arbitrary prose.

Regression coverage includes real Postgres/HTTP delivery, receipt scoping,
observed-profile requirements, fabricated authority, duplicate calls and
application, stale approval, cap exhaustion, changed verification at commit and
zero mastery changes. Real Temporal recovery loses a committed application's
acknowledgement and restarts its worker. Connected phone/tablet/desktop browser
tests render the new lesson, reload it, and check accessibility and the still
locked completion gate. External model responses are synthetic; real-provider
quality and learning effectiveness remain separate acceptance gates.
