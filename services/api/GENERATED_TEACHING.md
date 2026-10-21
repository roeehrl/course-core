# Novel teaching through course-owned verification

The supervisor can generate new explanation or practice text, whole lessons,
simulations, check questions, code exercises and interactive components, instead
of only selecting an existing reviewed bank entry. Generation is a proposal. It does not
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

## Bounded check and repair

`check_teaching` checks an already staged candidate by its returned artifact
digest. It cannot supply new content, a tenant, grading keys, a verifier or a
claimed proof. The host loads only that operation's actual candidate and runs
the installed independent verifier under current consent, target and registry
constraints. Feedback contains check IDs and passed/rejected/unavailable status;
it does not establish mastery or deliver a lesson.

The supervisor can replace a rejected draft, or select existing reviewed support.
At most two generated candidates are allowed per job, and only the last selected
teaching option can be delivered. All model rounds share the existing deadline,
configured round bound and budget reservation. A five-round generation/check/
repair/finish path needs sufficient explicitly configured round and token
allowance; this feature does not increase a user's ceilings. If the available
rounds expire without a valid finish, the operation cannot deliver its draft.

Final independent verification and transactional application still repeat the
checks. Earlier rejected/superseded candidates are retained as scoped receipts,
withheld from the ordinary timeline as prose, and never appended to the lesson.
Checking a draft cannot change learner evidence or infer a learner deficiency.
Duplicate same-step checks reuse the stored result without another execution.
Cancellation reaches the verifier, rolls back an incomplete check receipt and
prevents a later model round. Repair creates no additional course assignment;
the one delivered item consumes its approved work exactly once.

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

Generated-teaching profiles can also declare a `generationBrief` of at most
3,000 characters. Use it to describe the expected format, supported examples,
audience or reasoning constraints without exposing private verifier programs or
assessment answer keys. The scoped profile-list tool supplies the approved brief
to the model as creator content; it grants no tool, proof, grading or spending
authority. Editing a brief changes the registry configuration identity and
requires approval, so a pending candidate cannot silently borrow revised terms.
Other adapter kinds reject this field instead of pretending to use it.

One registry supports up to 512 unique profiles under the existing 2 MiB request
envelope. This permits assessment and teaching profiles across a complete course.
It is still bounded: ordinary model requests list only current-episode profiles,
the 12,000-character tool projection limit remains enforced, and learner work,
deadline, model-input and paid budgets are unchanged.

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

Whole generated lessons, advanced branches, simulations, check questions, code
exercises and interactive components use the same path; see "Generated
interactive content" below. Images, video and research attachments have their
own staff-reviewed paths.

## Generated interactive content

Besides text and whole lessons, an approved generated-teaching profile can let the
supervisor create one of these. The profile's operation decides which, and the
model cannot choose another (`GENERATED_TEACHING_SCOPE`):

| Profile | `create_teaching` kind | Delivered as | Host check (on top of the course verifier) |
| --- | --- | --- | --- |
| `attach_visual` | `simulation` | an SDK visual drawn by the installed scene renderer | `host-model-agreement` |
| `add_assessment_variant` of a numeric or prediction item | `check_item` | a variant of that canonical item | `host-answer-key` |
| `add_assessment_variant` of a code item | `code_exercise` | a variant of that canonical item, graded on its own hidden tests | `host-code-reference` |
| `append_teaching` with `component: { evaluatorId }` | `component` | a text block (the component's alternative) plus a published component | `host-component-tests` |

`src/generated-content.ts` holds the checks. All of them run at `check_teaching`
(as feedback the supervisor can repair, with `contentProblems` codes), again at
the separate verification phase, and again inside the atomic delivery. A candidate
whose structure is wrong is refused at `create_teaching` with
`{selected: false, reason: "content_invalid", problems}`; nothing is staged.

**Simulations** are data in the released scene contract (`packages/visuals`), never
code. The host names the scene, so a model cannot shadow a course visual. The
installed renderer's own publication checks run (every layout, reduced motion,
invariants and goldens), the declared build must support every render feature the
scene uses, and the scene must declare at least one invariant tying its
representations together. Registry approval needs the scene renderer declared by
the course and installed (`GENERATED_SIMULATION_RENDERER_UNAVAILABLE`).

**Check questions: one computational model (E04).** A question names a scene of the
learner's delivered course (an authored visual or a delivered personal simulation),
a model state and one read: a formula value, a trace-table cell or a node property.
`list_generation_profiles` describes the lesson's scenes by structure only (state
fields with bounds, formula symbols, table shapes), never values. The host sets the
scene to that state, requires the scene's invariants to hold there at every layout,
and reads the value: that is the answer key. A key the model claims (`answer`) is
only compared with it, using the canonical item's tolerances. The prompt must state
every number the key depends on. At delivery the key is derived again from the
course as it then is; a changed model, a tampered key or a contradictory scene
(for example a formula changed without its trace) is refused. The binding is kept
in the variant's hidden fixtures, which never reach the learner bundle or export.

**Code exercises.** The candidate brings hidden tests, a reference solution and one
to three plausible wrong solutions. The item keeps the canonical item's language
and evaluator, and names its tests by digest (`fixtureRef: generated-<sha256>`).
The installed evaluator runs, in the isolated grader (the networkless, read-only
Docker sandbox), the reference, which must pass, and the starter and every wrong
solution, which must fail. Learner answers are graded on the same stored tests
(`gradeCodeAnswer`), never on anything an answer sends. The evaluator must offer
`evaluateGeneratedCode` (`GENERATED_CODE_EVALUATOR_UNAVAILABLE` otherwise); the
stock fixture-registry evaluator does.

**Mastery.** Only verified items are delivered. A delivered variant joins its
canonical item's checkpoint exactly as any verified variant does: same type,
objectives, tolerances, evaluator and thresholds. Simulations, components and text
never create evidence.

### Generated components (E05)

A component is a small Python model, `solve(inputs) -> outputs`, with one to six
labelled number controls (each with a range, step and starting value), one to
eight labelled outputs and three to twelve tests. It is built and tested in an
isolated workspace before it can be published: every test must use exactly the
declared controls within range and exactly the declared outputs, one test must be
the starting position, the tests must tell positions apart, and the model must pass
every test in the installed grader. The lesson block is a text alternative the host
writes (markup escaped), which the course verifier and the accessibility check read.
It names each control with its range, step and starting value and each output, then
gives the outputs at the starting position and, for each control that some test moves
on its own from the start, what the outputs show when that control goes up ("When
Slope goes from 2 to 3 (other controls unchanged): y goes from 7 to 10."). Every
value comes from a test the grader ran; tests that move several controls stay
server-side. The phrases follow the course locale (English and Hebrew; any other
language gets symbols only, never English words). On delivery the component is
published once, content-addressed and immutable (migration 093, `generated_components`).

`GET /api/enrollments/:id/components` (the learner, or staff who may view the
enrollment) returns the live components without their tests, with the verified
outputs at the starting position (`start.outputs`), which the panel shows until the
learner moves a control. The learner page runs
a component only in Core's sandboxed Python runner frame (opaque origin, no
network, no access to the page) and shows the declared outputs it returns as text.
Generated code never runs in the API process or the learner page's origin.
Undoing the change withdraws the component; erasure redacts it.

### Safe boundary (E03)

A generated addition to the lesson the learner is in waits while the learner is
mid-attempt there: an issued, unanswered and unexpired question in that lesson, or a
part of that lesson they are using now (`safeBoundary`). The learner app reports that
signal itself (`activity-presence.ts`, migration 106): an activity, simulation or
generated component is open from the learner's first press, key or edit in it, the app
repeats the report every 45 seconds while the part stays in view, and it reports the
part closed when the learner scrolls away from it, hides the tab, leaves the page
(sent with `keepalive`), or finishes it. Saving an activity's state also counts as
open, and finishing the activity closes it. Reading past a part never counts. A
report not repeated for 90 seconds lapses, so a crashed tab or a closed laptop holds
a change back for at most that long, and an explicit close lets it land at once.

- `POST /api/enrollments/:id/presence` `{episodeId, blockId, kind: activity|simulation|component, state: open|closed}`
  (the learner only; changes no revision, so the app does not reload). Repeats within
  15 seconds write nothing; at most 32 parts per enrollment are kept, closed and lapsed
  ones make room first, then `PRESENCE_LIMIT` (429). Erasure deletes the rows; they are
  short-lived and not part of the data export.

When the learner adds a waiting change, the part of the lesson at the top of their
view (or the control they had focused) stays where it was on screen and keeps focus;
the addition lands at the end of the lesson. Inserting a whole lesson after the current one never waits: it is
a clearly marked insertion that does not change the lesson in progress. A waiting
change is kept as a pending personal change (migration 092) and nothing in the
lesson, evidence or work accounting changes. The learner sees it above the lesson
without its content and adds it once the attempt ends, or turns it down:

- `GET /api/enrollments/:id/personal-changes/pending` (learner only)
- `POST …/personal-changes/pending/apply` `{expectedRevision, idempotencyKey, pendingId}`;
  `ADAPTATION_NOT_AT_SAFE_BOUNDARY` while still mid-attempt
- `POST …/personal-changes/pending/decline`

Each delivered generated change keeps a validation report with its revision
(`adaptation_validation_reports`, migration 092, never changed): the artifact kind
and digest, the plan revision, the course verifier's version and checks, the host
checks it passed, and whether it was safe at delivery or added by the learner after
an attempt. "Your personal changes" shows it in plain words.

Adding repeats every check of the first delivery (consent, registry, target, course
verifier, host checks, policy and caps). A change that can no longer be delivered
lapses with its error code and changes nothing. Additions only ever append, so the
learner's place, read parts, code drafts and activity state are kept.

### Labels and undo (E06)

Everything generated is labelled where the learner meets it: the "Unverified" label
on a generated part, lesson or question (a check that asks a generated question
says its key was checked automatically and no person reviewed it). Simulations,
text, lessons and components can be undone from "Your personal changes"; generated
questions stay, because attempts and evidence may refer to them.

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
