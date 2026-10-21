# Writing a course without changing Core

A course is SDK data. Core runs it with what it has installed; an author never edits Core. This guide covers the three things an outside author most often adds. `examples/courses/src/clean-room-lab.mjs` is a working example that imports only the released SDK, and `npm run proof:clean-room` in `examples/courses` runs it on the built Core over HTTP (see that README).

## 1. Find what the host runs

`GET /api/runtime/extensions` (any signed-in member) lists each installed build: `id`, `version`, `integrity`, `capabilities`, `platforms`. A course declares a build in `extensions[]` with exactly that version and integrity. Core always installs:

| Id | What it is |
| --- | --- |
| `course-core-declarative-activity` | Renders declarative activities with the learner app's own controls (`execution: 'declarative'`). No course code runs. |
| `course-core-declarative-evaluator` | Checks declarative activity submissions against the course's own items (`execution: 'server'`, capability `assessment.evaluate`). Data only. |
| `course-core-reviewed-rubric`, `course-core-svg-v1` | Reviewed rubric items and SVG visuals (see the root README). |

## 2. An activity

Use `defineActivity` with `executionAdapter: 'declarative'` and renderer refs naming `course-core-declarative-activity`, and put an `{ type: 'activity', activityId, configuration }` block in an episode. The configuration is `{ prompt, controls, submitLabel? }`, with 1 to 12 controls: `number` (`min`, `max`, optional `step`), `choice` (2 to 12 `options`) or `toggle`. The learner receives the configuration, so it must not contain answers. Publication refuses a configuration, capability or target Core cannot run, with a `PUBLISH_ACTIVITY_*` code.

## 3. An evaluator

Without an evaluator an activity is practice: submitting completes the block but is never evidence. To grade it with no host install, add:

- `defineEvaluator({ id, extensionId: 'course-core-declarative-evaluator', method: 'deterministic', humanConfirmation: 'none', itemTypes: ['numeric', 'choice'], … })` and set the activity's `evaluatorRef` to its `id`;
- for each control to check, an ordinary item with id `<activityId>.<controlId>`: `numeric` for a number control (its tolerance applies) or `choice` for a choice control (its correct option must be one of the control's options). Items are server-only. Toggles are not checked.

A submission passes when every checked control matches, and only then is it activity evidence. Publication refuses a key it cannot apply with `PUBLISH_EVALUATOR_CONFIGURATION_INVALID` and a `reason` (`key_item_missing`, `key_item_mismatch`, `evaluator_definition_required`, `declarative_activity_required`, `feedback_setting_invalid`). Code, prose and other judgments need an evaluator the host installs and trusts.

## 4. An admin setting

`defineAdminSection` declares a form Core renders for staff, with permissions and typed settings at course, chapter or enrollment scope; every change is audited. The SDK refuses settings that would steer grading, evidence, caps or policy. Installed evaluators receive the enrollment's effective section values. The built-in checker reads one: in a section whose id is the evaluator definition's id, a boolean `show-mismatched-controls` makes a result that did not pass name the labels of the controls that did not match.
