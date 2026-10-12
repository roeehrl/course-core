# Course Core engineering rules

- Public, course-agnostic infrastructure only. No private course fixtures, learner records, credentials or host paths.
- Import released SDK contracts rather than private course code. Domain behavior belongs in course bundles or registered extensions.
- Responsive phone/tablet/widescreen web UX and future native compatibility are required. Mobile application builds are deferred by the user for the current implementation.
- Server authorization, versioned evidence, policy and transactional receipts govern progression; client controls and model output do not grant credit.
- Preserve durability, idempotency, caps and extension accounting through retries and failures.
- No untrusted code in the application process. No provider credentials in browser bundles or logs.
- Validate real workflows and negative cases. Mocks do not establish live provider/deployment acceptance.
- Do not add model/agent attribution to commits or generated project files.
