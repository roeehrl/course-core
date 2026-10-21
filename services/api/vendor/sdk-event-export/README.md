# Vendored SDK learning-event export schema

`learning-event-export.schema.json` is the SDK 0.6.0 `learningEventExport` record schema (exportFormat 1), derived
unchanged by the SDK's own `scripts/event-export-schema.mjs` from `src/course.schema.json` at course-sdk commit
`250a8d944253703a746ded88a99f34904213910c`. SDK 0.6.0 is not released yet, so Core cannot import
`@course-core/sdk/event-export-schema`. Tests validate every export Core produces (`src/event-export.ts`) against this
file. When Core pins SDK 0.6.0, delete this directory and validate against the released export instead.
