# Graded checks and the companion

The companion (the tutor; Hebrew: המנחה) explains, works through examples and corrects
misconceptions. It never hands a learner the answer to one of the course's graded checks, whether
or not an attempt is open. Answer keys may be public in a course repository; the rule is about
what the tutor says, not about secrecy.

Before this change the only gate applied while an independent attempt was open
(`ASSESSMENT_HELP_CONSENT_REQUIRED`, `independentAssessmentActive`). With no attempt open, a learner
who pasted or described a check could get its answer. Core now applies three deterministic,
provider-independent layers (`services/api/src/companion-check-integrity.ts`).

## 1. Instruction

Every companion request carries the graded-check rule in Core's strategy
(`agent-strategies.ts`, `GRADED_CHECK_RULE`): never state, choose, confirm or rule out the answer
to a graded check, open or not, even when the learner pastes it, calls it practice or insists;
instead explain the idea it tests, work a similar example with different numbers or a different
scenario, and ask one guiding question; still correct misconceptions, without applying the
correction to the check's own case. Because it is in the strategy, it applies to every provider
and to course-declared strategies that narrow Core's (`course-strategies.ts`).

## 2. Matching a question to checks

When the context of a companion turn is assembled (`provider-context.ts`), the learner's question
is matched against the course release's assessments:

| Match | When |
| --- | --- |
| `quoted` | The question contains a check, from anywhere in the course: most of its prompt words (60% and at least three), its word sequences, or two of its options. |
| `described` | The question asks for an answer (or names a check) and shares a large part of a check's wording (35% and at least three words), for checks in this lesson, the lessons just before and after it, and items with an open attempt; anywhere in the course when one sentence both asks for an answer and names a check. |
| `referenced` | One sentence asks for an answer and names a check ("for the transfer check coming up, which option should I pick?", "איזו אפשרות לבחור בבדיקה?"): this lesson's check its words point at, otherwise the next check after the part being read. |
| `earlier_message` | A short follow-up ("is it 3?", "אז זה 10?") about a check the learner pasted or described in one of their last three messages in this lesson. |

Text the learner copied from a lesson is not their own words: sentences found in the course's
lesson text are left out before matching, so "explain this paragraph" is not a check request.
Matching uses folded text (case, Hebrew points, typography, Markdown and simple TeX), light English
stemming and Hebrew prefix letters, and works for English and Hebrew messages. At most three
checks are matched; a pasted check is reported alone, without checks that only share its
vocabulary.

A match switches the turn to **check-coaching mode**:

- The context gets `checkCoaching`: each matched check's id, type, prompt and options, never its
  key or explanation. The model knows which item it must not answer and what to avoid restating.
- The instruction adds `CHECK_COACHING_RULE`: say briefly that graded checks are not answered,
  then coach: the idea the check tests, a similar example with different values, one guiding
  question; no reference to the check's options by letter, number, position or wording.
- The reply is **not streamed as a draft**: the learner sees it only after the gateway has checked
  it (below).

## 3. Verifying the reply before it is kept

In check-coaching mode the provider gateway (`provider-gateway.ts`, `guardCompanionReply`) checks
the whole reply against the matched checks' keys, read from the job's course release, before
anything is stored:

| Item | Withheld when the reply |
| --- | --- |
| choice | quotes the correct option's wording (verbatim, or 80% of its words in one sentence), or names some but not all options by letter, number, position or Hebrew letter ("c", "(c)", "option C", "the third option", "rule out a and b", "it's not d", "אפשרות ג", "ג'", "האפשרות השלישית"); naming every option is fine |
| numeric, prediction | states the expected value within its tolerance: digits, "minus 3", simple fractions, English and Hebrew number words; list markers, exponents and numbers inside words do not count |
| trace | states a step's answer |
| any | answers yes or no ("Yes", "That's right", "Not quite", "כן", "נכון") when the learner asked whether an answer is right |

On a hit the reply is withheld: it is never stored (not in the artifact, the dispatch receipt or
the conversation), an open draft is withdrawn with reason `check_answer_withheld`, and a fixed
coaching message is delivered in its place, in the language of the question (Hebrew when it has
Hebrew words, written gender-neutrally). The call is charged at its reported usage like any reply;
the message adds no call. The stored reply carries the reason code: artifact
`{ kind: 'companion_message', text, withheld }` and, on the conversation message, context
`checkAnswerWithheld` (`check_answer_stated`, `check_option_named`, `check_answer_confirmed`, or
`check_keys_unavailable` when the checks could not be read back, which fails closed). The
dispatch receipt's candidate records the matched check ids.

The companion verifier (`companion-verifier.ts`) repeats the check on the stored reply of a
coaching-mode dispatch and rejects it on a hit, so a reply that reached storage some other way is
still never delivered.

Regenerating the reply was considered and not used: a companion job reserves one call, and a
second call could exceed the reservation and fail the job (`usage_exceeded`).

## Quality checks

The public eval suite (`services/api/AGENT_EVALS.md`) has check-answer dialogues: a pasted check
asking for only the number, the same in Hebrew, multiple-choice elimination, and "is it 3?" after
the check was pasted earlier. A dialogue's `checks` are the pack's own items with their keys; the
runner matches the question as Core does and runs the strategy in check-coaching mode, and the
`hint_leakage` grader also applies the verifier above (`check_answer:<reason>`). A model that
leaks under coaching fails the check, even though Core would have withheld the reply in
production.

## Limits

- The verifier catches explicit answers. A paraphrase that decides an item without its option,
  value or wording (for example restating the check's scenario and classifying it) is not detected;
  the instruction and the eval cases cover it.
- Rubric, code and production items have no deterministic key: only the instruction and the
  yes/no rule apply. A one-character trace answer is not checked.
- A question that matches no check is not verified against keys. Matching is lexical; a check
  described in entirely different words may be missed.
- In check-coaching mode a reply that mentions a check's answer value for another reason (the
  lesson's own example has the same number) is withheld too; the learner gets the coaching
  message and can ask again.
