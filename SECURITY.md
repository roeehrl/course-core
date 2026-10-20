# Security policy

This repository is under active integration. Tests and demo UI behavior do not establish production readiness or a security support guarantee for a deployed service.

The [threat model](docs/threat-model.md) lists the assets, trust boundaries, threats, existing mitigations (with the code that implements them) and the residual risks of the system as built.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/roeehrl/course-core/security/advisories/new) when enabled. Maintainers must enable this channel before a public release. If unavailable, request a private contact channel from `@roeehrl` without publishing exploit details, secrets, learner records, or private course content. Include affected revisions and a minimal synthetic reproduction.

The API must enforce authentication, tenant isolation, CSRF/origin policy, versioned evidence, idempotency, transaction boundaries and durable receipts. A pure policy decision, client control, demo receipt or model response cannot grant credit. Test-database credentials are public disposable values, not production credentials. Root checks reject remote/application database targets and never fall back from `TEST_DATABASE_URL` to `DATABASE_URL`.

The connected learner at `/` uses server authority; the labeled `/demo` route remains local demo behavior. API browser tests use a test-only loopback host, fresh schema and synthetic accounts. Keep that host out of application builds and production routes. The trusted bootstrap CLI emits a one-time sign-in credential; do not expose it in source, browser artifacts or public logs. Configure `PUBLIC_ORIGIN` to match the browser origin, retain loopback binding for local HTTP, and use HTTPS for remote application serving.

Provider credentials belong server-side. Browser builds and public logs must contain no API keys, learner data, private course material or unrestricted provider responses. Untrusted course extensions and provider output must not execute in the application process. Applications must enforce capabilities and evidence integrity independently of authoring validation.

The practical exercise sandbox keeps the trusted reference grader outside the learner container. Its current Python runner uses a digest-pinned image, no network or host/provider environment, a read-only root, finite memory/time/output limits and a filesystem admission lock. CI explicitly prepares the native image before real Docker tests; learner execution never pulls an image. A passed container test is not proof against host-kernel vulnerabilities or production multi-tenant compromise. Follow the [sandbox package's boundary and cleanup requirements](packages/sandbox/README.md) before production use; no GPU or local-model execution is included.

Public CI uses Node 26, disposable PostgreSQL 17, public SDK/npm dependencies, and synthetic browser sessions. It never fetches private repositories or calls live providers. Its token is read-only and no publishing/deployment secrets are supplied to pull requests. Only the two known public owner repositories are allowed in source references.

Automated source/credential and axe checks are bounded checks, not proof that all private data, security flaws or accessibility problems have been excluded. Review public artifacts and validate the actual deployed authentication, data, browser and provider paths before a live rollout.
