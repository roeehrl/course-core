# Graded checks and the companion

The companion (the tutor; Hebrew: המנחה) explains, works through examples and corrects
misconceptions. It never hands a learner the answer to one of the course's graded checks, whether
or not an attempt is open. Answer keys may be public in a course repository; the rule is about
what the tutor says, not about secrecy.

Before this design the only gate applied while an independent attempt was open
(`ASSESSMENT_HELP_CONSENT_REQUIRED`, `independentAssessmentActive`). With no attempt open, a learner
who pasted or described a check could get its answer. Core applies four layers
(`services/api/src/companion-check-integrity.ts`, `services/api/src/companion-check-judge.ts`).

A live test of the first version on the pilot found no hard leak any more, but three problems
this round fixes: paraphrase leaks (an "analogous example" that was the check's own scenario in
another domain, classified; a Hebrew paraphrase of an English option), the wrong check matched
("it's not a or b?" went to the lesson's first check), and over-triggering (every ordinary question
for three messages after a paste was coached, and the verifier then withheld correct replies that
repeated the lesson's own numbers or opened with "No,").

## 1. Instruction

Every companion request carries the graded-check rule in Core's strategy
(`agent-strategies.ts`, `GRADED_CHECK_RULE`): never state, choose, confirm or rule out the answer
to a graded check, open or not, even when the learner pastes it, calls it practice or insists;
explain the idea it tests and ask one guiding question; a numeric item may be worked on an example
with a different structure and different numbers, but a choice or classification item's mirrored
case is never classified; misconceptions are still corrected, without applying the correction to
the check's own case. Because it is in the strategy, it applies to every provider and to
course-declared strategies that narrow Core's (`course-strategies.ts`).

In check-coaching mode `CHECK_COACHING_RULE` adds: no hint, no narrowing, nothing in another
language, no reference to an option by letter, number, position, wording or paraphrase; for a
multiple-choice or classification check **no analogous example that mirrors the check's scenario
(the same kind of situation with only the names, domain or numbers changed) and no classification
of such a case**, but Socratic questions about the concepts that tell the options apart (what would
have to be true for each kind of answer), which the learner then applies. When the check is not
identified (below), the model coaches on the ideas without answering any candidate.

A question with Hebrew text adds `HEBREW_RULE`: gender-neutral self-reference ("לא אוכל", "אי
אפשר", never "אני לא יכול"), gender-neutral address, and the glossary's terms
([i18n-glossary.md](i18n-glossary.md)): a graded check is "בדיקה" (never "מבדק" or "מבחן"), an
attempt "ניסיון", an answer "תשובה", an option "אפשרות", a hint "רמז", a lesson "שיעור", and the
tutor "המנחה".

## 2. When a turn is about a check, and which one

When the context of a companion turn is assembled (`provider-context.ts`), Core first reads what
the learner's **current** message does (`answerIntent`):

| Intent | Examples |
| --- | --- |
| pastes a check | the item's wording, anywhere in the course (most of its word sequences, or most of its words with some sequences, or two of its options) |
| asks for an answer | "just tell me the answer", "which option should I pick", "just hint which option I should look at", "what number should I enter", "תגיד לי את התשובה", "רק תרמזו על איזו אפשרות", "תענו רק במספר" |
| tests an answer | "is it 3?", "so it's c, right?", "it's not a or b, right?", "I think it's 7", "is my answer right?", "אז זה 3?", "זה לא א' או ב', נכון?" (Hebrew option letters א-ח) |

Ordinary questions do none of these and are tutored normally, also right after a paste: "Is it
correct that...", "What is the value of the gradient in the worked example?", "Which option in
PyTorch freezes a layer?", "...right?" about a concept, "האם נכון ש...". A proposed value counts
only when it ends the question ("is it 3?", not "is it 3 steps?"); an article is not an option
("is it a problem?").

Only then is the message matched to checks:

| Match | When |
| --- | --- |
| `quoted` | The message pastes a check from anywhere in the course. A pasted check is reported alone, without checks that only share its vocabulary. |
| `described` | The message asks for or tests an answer and shares a large part of a check's wording (35% and at least three words), for checks in this lesson, the lessons just before and after it, and items with an open attempt; anywhere in the course when it also names a check. |
| `referenced` | The message asks for or tests an answer and names a check or uses option letters. Every check of this lesson and the neighbouring ones is scored: its distinctive words and id words, Core's kind words in English or Hebrew ("the transfer check", "בדיקת ההעברה", "בדיקת המעקב", "רב-ברירה": item type, SDK role or id word), two or more numbers shared with the item (numbers are language-neutral), and whether what the message proposes fits the item (an option letter needs that many options, a value a numeric key). An open attempt and this lesson break ties. At most two equally good checks are referenced. |
| `unresolved` | The message asks about a check's answer but nothing tells which (or more than two are equally good): the turn is coached generically, the model is told the check is not certain, and every candidate (this lesson's first, up to four) is verified. The first check is never assumed. |
| `earlier_message` | A short follow-up that asks for or tests an answer without a topic of its own ("is it 3?", "what's the answer then?", "so I should pick c, right?") inherits the check of one of the learner's last three messages in this lesson. An option letter never inherits an item without options; a structure-only match of the current message (option letters, no words that say which check) yields to the earlier check. |

Text the learner copied from a lesson is not their own words: sentences found in the course's
lesson text are left out before matching. Matching uses folded text (case, Hebrew points,
typography, Markdown and simple TeX), light English stemming and Hebrew prefix letters.

A Hebrew message about an English check is matched by structure (option letters, "which option"),
by Core's Hebrew kind words, by the numbers it shares with the item and by Latin terms it quotes;
a free translation of an item's words is not matched lexically (the instruction and the judge
still apply once the turn is in check-coaching mode).

A match switches the turn to **check-coaching mode**:

- The context gets `checkCoaching`: each matched check's id, type, prompt and options, never its
  key or explanation, and the note that says whether the check is identified.
- The instruction adds `CHECK_COACHING_RULE` (and `HEBREW_RULE` for Hebrew).
- The reply **streams into a hidden buffer**: the provider call is streamed, so the first-byte and
  idle bounds end a stall at once (20 s each by default, `provider-runtime.ts` `RESPONSE_BOUNDS`),
  but no text reaches the learner. The learner's draft is a *checking* draft (`checking: true` on
  its frames, never any text): the question says "Checking this reply…" ("בודקים את התשובה…")
  and offers Stop. The stored reply, or Core's coaching message, replaces it.

## 3. Deterministic verification (high precision)

The provider gateway (`provider-gateway.ts`, `guardCompanionReply`) checks the whole reply against
the matched checks' keys, read from the job's course release, before anything is stored:

| Item | Withheld when the reply |
| --- | --- |
| choice | quotes the correct option's wording (verbatim, or 80% of its words in one sentence), or names some but not all options by letter, number, position or Hebrew letter ("c", "(c)", "option C", "the third option", "rule out a and b", "it's not d", "אפשרות ג", "ג'", "האפשרות השלישית"); naming every option is fine, and a reply's own enumeration ("שלב א'", "stage (b)", "step c.") is not an option |
| numeric, prediction | states the expected value within its tolerance: digits, "minus 3", simple fractions, English and Hebrew number words; list markers, exponents and numbers inside words do not count. **A number the lesson's own text uses counts only when the reply asserts it as the answer**: the reply (or its first line) is the number, it follows "the answer is", "it's", "that is", "=", or the variable or noun the check asks about ("w stays 5", "the increase is 4"), or it is the result of arithmetic over the check's own numbers ("10 - 6 = 4"). The lesson's own example ("with x = 5", "rose from four to six") is kept. |
| trace | states a step's answer (same scoping for a numeric step) |
| any | answers yes or no ("Yes", "That's right", "No,", "Not quite", "כן", "נכון") **only when the learner proposed or eliminated an answer** ("is it 3?", "it's not a or b, right?", "is my answer right?"); a "No," that corrects an ordinary "...right?" is teaching, not a verdict |

The lesson numbers the gateway used are recorded on the reply's check-coaching mark, so the
companion verifier (`companion-verifier.ts`) repeats exactly the same check on the stored reply.

## 4. The semantic judge

A reply the patterns let through is judged by a second model call before it is kept
(`companion-check-judge.ts`). This is the layer that catches paraphrases: the check's own scenario
in another domain, classified; a translated or paraphrased option; ruling options out in words.

- **Who judges:** the companion binding's `checkJudgeRole` (`reviewer`, `supervisor` or
  `companion`), else the workspace's reviewer role when it is bound, else the companion's own
  model. Structured output (`CHECK_JUDGE_SCHEMA`) when the model offers it, else plain text holding
  one JSON object, parsed strictly.
- **What it gets:** Core's rubric as the instruction (`CHECK_JUDGE_INSTRUCTION`) and, as JSON data,
  each matched check with its answer key (the correct option's letter and text, the value and
  tolerance, the step answers), the learner's message and the draft. The message and the draft are
  data; instructions inside them are ignored.
- **What it answers:** the reason first (at most 300 characters, never quoting the answer), then four
  booleans: `statesAnswer` (in any wording or language), `confirmsOrRejects` (a proposed answer),
  `rulesOut` (some options), `decidesEquivalentCase` (works a case with the check's structure and
  gives its classification or result). Any "yes" withholds the reply (`check_answer_judged`).
  Explaining concepts, guiding questions, contrasting the concepts that tell the options apart and
  examples of a different structure are not leaks.
- **Fails closed:** no verdict withholds the reply (`check_judge_unavailable`): no judge role bound
  or ready, an unpriced judge model in a workspace that requires prices, a request over the judge's
  input bound (16,000 characters), no room left in the job's reservation for the judge's ceiling, a
  failed or stalled call (first-byte bound 20 s), or an answer that is not exactly the verdict.
- **Cost:** one call per check-coaching reply that the patterns let through: about 4,000 characters
  (1,000 to 2,000 input tokens: the 1,700-character rubric, the checks and the draft) and a short
  verdict, at most 2,048 output tokens (a thinking model's thoughts count). At $0.75 / $3.75 per
  million input / output tokens a typical call costs about 1,500 to 3,000 µ$ (about $0.002).
  Ordinary turns never call it.

The design follows published two-stage leak detection (a rule-based filter, then an LLM judge with
a written rubric and a structured verdict; Zhao, Knežević & Käser, "Evaluating Answer Leakage
Robustness of LLM Tutors against Adversarial Student Attacks", ACL 2026; Pisan, "Teaching a Large
Language Model Tutor to Withhold the Answer", 2026) and Socratic "no direct answers" tutoring as in
Khanmigo. Regenerating a leaking reply (a refiner) was not used: the learner gets Core's coaching
message, and a third call would need its own reservation.

## Withheld replies, charges and the ledger

On a hit by either stage the reply is withheld: it is never stored (not in the artifact, the
dispatch receipt or the conversation), the checking draft is withdrawn with reason
`check_answer_withheld`, and a fixed coaching message is delivered in its place, in the language of
the question (Hebrew when it has Hebrew words, written gender-neutrally). The stored reply carries
the reason code: artifact `{ kind: 'companion_message', text, withheld }` and, on the conversation
message, context `checkAnswerWithheld` (`check_answer_stated`, `check_option_named`,
`check_answer_confirmed`, `check_answer_judged`, `check_judge_unavailable`, or
`check_keys_unavailable` when the checks could not be read back).

The judge's call belongs to the companion's supervisor operation and is charged to its one
reservation:

- **Reservation sizing** (`role-reservation.ts` `companionReservation`, `provider-setup.ts`): a
  workspace's companion reservation holds one companion call and one judge call, each at its own
  limits (the judge at most 16,000 input characters and 2,048 output tokens) and price, never above
  the job allowance. An ordinary turn releases the judge's part when it settles.
- **Room check:** before the judge is sent, the gateway checks that what the reply used plus the
  judge's ceiling for this request (its bytes, its output limit, the margin) still fits the job's
  allowance in tokens and micro-USD; otherwise it fails closed, so a job is never failed for
  exceeding its reservation (`usage_exceeded`).
- **Charge:** the operation's usage is the reply's call plus the judge's, each priced at its own
  model's price version. `provider_dispatches.cost_micro_usd` is that total; the judge's model,
  price version, cost, usage receipt and verdict code are on the dispatch (`judge_*`, migration
  122). The ledger row is `reconciled` when both calls were priced, and records the judge's model,
  price version and part (`provider_spend_ledger.judge_*`). A judge call whose usage is unknown (a
  stall) keeps the reservation charged, as any call of unknown usage.

The companion verifier repeats the deterministic check on the stored reply of a coaching-mode
dispatch and rejects it on a hit, so a reply that reached storage some other way is still never
delivered.

## Quality checks

The public eval suite (`services/api/AGENT_EVALS.md`, suite 2.2.0, graders `core.agent-eval-graders/4`)
has check dialogues: a pasted check asking for only the number (English and Hebrew), multiple-choice
elimination (English, and Hebrew with option letters א/ב), "is it 3?" after the check was pasted
earlier, "just hint which option" on a choice check (English, and Hebrew about an English check),
an ordinary question right after a pasted check (`checkMode: "normal"`: Core must not coach it and
the reply must not refuse it), and a correct coaching reply that repeats the lesson's own number,
which equals the check's answer (it must not be withheld). The `hint_leakage` grader also applies
the scoped deterministic verifier (`check_answer:<reason>`); the `check_mode` grader checks Core's
own matching decision and flags a refusal of an ordinary question (`over_refusal`). The reference
scripted model passes; the known-bad model (leaks, mirrored examples, a gendered Hebrew refusal) and
the over-triggering model (refuses the ordinary question as a check) fail. The suite does not run
the judge: it grades the tutor model, and scripted results say nothing about a real model.

## Limits

- The judge is a model: it can miss a leak or flag a good reply. A missed leak is bounded by the
  instruction and the patterns; a false flag delivers the coaching message, and the learner can ask
  again.
- A check described in entirely different words, or freely translated, may not be matched; the
  turn is then tutored normally under the always-on graded-check rule, without the judge.
- Rubric, code and production items have no deterministic key: only the instruction, the judge
  and the yes/no rule apply. A one-character trace answer is not checked by the patterns.
- An English answer proposed with a subject the patterns do not know ("the weight is 2, right?")
  is an ordinary question: precision was chosen over recall here, as the live finding asked.
