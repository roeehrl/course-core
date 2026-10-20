# Usability protocol: the 90% task-success targets

This protocol says how to test the learner usability targets with real people and how to analyse the results together with a study's research export. The targets are product goals to check. They are not measured outcomes, and passing scripted or automated browser tests does not meet them.

## Targets

The design sets these release targets for technically experienced newcomers to AI:

| Id | Target | Pass threshold |
| --- | --- | --- |
| T1 | Find the required next action without coaching | at least 90% of sessions |
| T2 | Tell optional help apart from required work | at least 90% of sessions |
| T3 | Explain in their own words why a gate is holding them | at least 90% of sessions |

The protocol also records time to the next action, wrong turns, a successful return after a detour into media or help, and whether the learner's context was still there afterwards (context continuity).

## Who takes part

- Recruit technically experienced people who are new to AI courses. Pilot with the course owner first, then with consenting engineers from varied backgrounds.
- Each participant enrols as usual and then joins the course's study in the learner app (My profile, or the prompt on the course page). Joining is a separate, explicit choice. Do not run a session with anyone who has not joined, and do not record anything about people who decline.
- Before the session the participant opens My profile and reads out their **study code** (for example `P3F09A1C2B7`). The observer writes this code on the session sheet. No name, email or recording that shows a face or account name goes on the sheet. If you record the screen, crop or blur the account name, and keep recordings apart from the export.
- Anyone can stop at any time. Leaving the study in the app takes their data out of every later export. Destroy their session sheet as well.

## Setup

1. An owner or admin opens **Studies** in administration, picks a published release, and sets the arms (fixed path, chat-only companion, full supervisor), the instrument sets and the minimum cell size. Then they open recruiting.
2. Placement is a course-level setting. It is shown on the study card and is the same for every arm. Decide it before recruiting starts and leave it alone during the study.
3. Use the same device class for every session in a round (phone, tablet or desktop). Record the class on the sheet: the targets are checked per class.
4. Each session runs on the participant's real enrollment, in whatever arm they were assigned. Never move a participant to a different arm. The assignment is fixed and audited (**Check allocation** on the study card).

## Tasks

Give each task as written, then stay silent. A **hint** is any intervention after the task is given: a pointing gesture, a reworded question or an answer to "where do I…?". A task with a hint is not a success for its target.

| Task | Script | Measures |
| --- | --- | --- |
| A. First step | "You have just enrolled. Show me what you need to do next." | T1 success; seconds until the first correct action; wrong turns before it |
| B. Required or optional | Point at two items on the course page, one required and one optional (a detour, a suggested resource or the companion). Ask: "Do you have to do this one to finish? And this one?" | T2: both answered correctly |
| C. Held at a gate | Have the participant reach a gate they have not passed yet (answer one check wrong, or stop before the second independent family). Ask: "Why can't you continue?" | T3: names the missing evidence or criterion as the app shows it, in their own words |
| D. Detour and return | "Open the video (or the companion) for this lesson, then get back to where you were." | Return success without a hint; the same lesson and step is shown afterwards (context continuity) |
| E. Next action after a detour | Straight after D: "What do you do now?" | Counts as a second T1 trial |

Use the companion in D only where the participant's arm offers it. In the fixed path, use a media block or a reading detour instead. Record which you used.

## Session sheet (one per session)

`participant` (study code), `device_class` (phone, tablet or desktop), `date_week` (ISO week only), then for each task A to E: `success` (1/0), `hinted` (1/0), `seconds`, `wrong_turns` (count). Add `explanation_ok` for C (1/0, judged against the rubric below) and `context_kept` for D (1/0).

Do not write free-text notes about the person. Note an observation about the interface (for example "missed the Continue button under the fold") under a problem code from your issue tracker instead.

**T3 rubric.** An explanation passes if it names at least one of these things that the gate screen shows: a missing criterion, a missing independent check, an evidence family still needed, or a review the learner is waiting for. An explanation that blames the learner ("I'm not good enough"), or that only repeats "it's locked", does not pass.

## How the sheet joins the export

An owner or admin downloads the study's export (**Export CSV** or **Export JSON**). The download is recorded with the person who made it and the file's digest. Join the session sheet to the export on `participant`. The export fields are:

| Export field | Use in the analysis |
| --- | --- |
| `participant` | Join key: the same code the learner read out |
| `arm`, `behaviour` | Grouping: fixed, chat_only or supervisor |
| `consentedDay` | Days from the study opening to consent, a covariate for cohort effects |
| `pre_*`, `post_*`, `transfer_*`, `delayed_*` (`_items`, `_attempted`, `_correct`, `_score`, `_complete`, `_first_min`, `_last_min`) | Learning outcomes for each instrument set; `_first_min` is minutes from consent and can be negative for a pre-test taken before joining |
| `<set>:<item>` | Outcome of each item: `correct`, `incorrect`, `abstained`, `pending` or `not_attempted` |
| `episodes_completed`, `episodes_total`, `course_completed` | Progress, a covariate and a secondary outcome |

The export never holds names, emails, profile text, answers, messages or companion conversations. Pseudonyms are salted per study, so codes cannot be linked across studies. Arms with fewer consenting learners than the study's minimum cell size are left out, together with the overall total. If an arm is suppressed, add participants before you analyse that arm. Never add rows for it from the session sheets.

## Analysis plan

1. **Targets (primary).** For T1 to T3, compute the share of successful, unhinted trials per device class. Report the count, n and an exact (Clopper-Pearson) 95% interval. A target is met for a device class only when the **lower bound** is at least 0.90. With small n this is not possible: with 10 of 10 the lower bound is 0.69, and it takes 35 successes out of 35 to reach 0.90. Report the point estimate as provisional and say the target is "not yet established". Never claim it is met.
2. **By arm (secondary).** Break T1 to T3 and the continuity measures down by `behaviour`. The fixed path has no companion, so differences in D are partly built in. Keep this descriptive.
3. **Learning outcomes (secondary).** For each arm, compute the pre-test to post-test change as `post_score − pre_score` for participants with both sets complete, and report `transfer_score` and `delayed_score` separately. Compare arms only when every arm has at least the minimum cell size. Report effect sizes with intervals, not only p-values. A one-person or small pilot gives usability and case evidence, not a causal claim about learning gains.
4. **Missing data.** Count `_complete = 0` by arm. Do not impute delayed checks: the retention schedule offers them only after an objective is demonstrated, so a missing delayed check often means the learner never got that far.
5. **Exclusions.** People who left the study are already absent from the export. Exclude sessions with a technical failure (say an outage, not "the learner was confused") and report them separately with a reason code.

## Retention and erasure

Keep session sheets for no longer than the export they are joined to. A learner who leaves the study or erases their data drops out of every later export. When you get a new export, also delete that learner's session sheet, which you can identify by its study code.
