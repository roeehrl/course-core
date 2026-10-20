# Threat model

This is the threat model of Course Core as it is built in this repository: the API
(`services/api`), the supervisor and its Temporal workers (`services/supervisor`), the
learner and admin web apps (`apps/learner`, `apps/admin`), the practical-exercise sandbox
(`packages/sandbox`), the provider adapters (`packages/providers`) and the local pilot
launcher (`deploy/local`). It describes what the code does today, not what a
production deployment would need. Each threat lists the mitigation that exists, with
the code that implements it, and the residual risk that remains.

Paths are relative to the repository root. Line numbers refer to the revision this
document was written against; the function or symbol named next to them is the stable
reference. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Scope and assumptions

- The reference deployment is the **local pilot**: one macOS host, one operator,
  PostgreSQL 17 on loopback, a Temporal development server on loopback, the API on
  `127.0.0.1`, optional remote access over a Tailscale tailnet
  ([deploy/local/README.md](../deploy/local/README.md)). A remote deployment must put
  the API behind HTTPS (`services/api/src/main.ts:36-42` refuses a non-loopback
  `PUBLIC_ORIGIN` over plain HTTP).
- The host operating system, the operator's account and the PostgreSQL server are
  trusted. Anyone with the operator's shell has everything: database, provider vault
  key, configuration and backups. This model does not defend against that.
- Course authors are semi-trusted: their packages are validated and never executed
  (see [Course packages](#course-packages-and-installers)), but their text reaches
  learners and models.
- Learners are untrusted. So are model providers' outputs, retrieved research
  content, and any external agent a learner connects.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Learner data: accounts, answers, evidence, mastery, companion conversations, learner model, self-notes, exports | PostgreSQL; Temporal workflow history (`temporal.db` in the pilot state); browser storage for drafts and pending commands (`apps/learner/src/connected/drafts.ts`, `apps/learner/src/client/apiClient.ts:279-280`) | Personal data; integrity of earned credit |
| Credentials: password hashes, session and CSRF token digests, sign-in code digests, passkey public keys, agent-tool token digests | PostgreSQL (`services/api/src/passwords.ts`, `auth.ts`, `passkeys.ts`, `agent-tools-routes.ts`) | Account takeover |
| Service token (`serviceToken` / `SUPERVISOR_HOST_TOKEN`) | Pilot `config.json` (0600), process environment | Calls the supervisor bridge and provider gateway as the service |
| Provider keys | Sealed in PostgreSQL with the vault key in `provider-key.bin` (`services/api/src/key-vault.ts`), or plaintext in the pilot's `providerCredentials` | Spend, and the provider account |
| Course bundles and releases | PostgreSQL `course_releases`; package files in configured directories or GitHub releases | What learners are taught and graded against; hidden grading fixtures |
| Backups | Operator-chosen directory (`deploy/local/backup.mjs`) | Contain all of the above, including the vault key |

## Actors and trust boundaries

```
 browser (learner/admin) ──HTTPS or loopback/tailnet HTTP──▶ API (Fastify, 127.0.0.1)
   └─ sandboxed activity iframe (opaque origin, MessageChannel)        │
 external agent (MCP) ──Bearer ccat_ token──▶ API /api/agent-tools      │
 supervisor dispatcher + worker ──Bearer service token──▶ API /v1/*   │
            │                                                          ├──▶ PostgreSQL (loopback)
            └──gRPC loopback──▶ Temporal dev server (127.0.0.1)       ├──▶ provider HTTP APIs (outbound)
 operator shell ──▶ pilot.mjs / backup.mjs / bootstrap CLI             ├──▶ Docker daemon (sandbox containers)
 course package (upload, directory, GitHub release) ──▶ API installer  └──▶ OTLP collector (optional, outbound)
```

1. **Browser ↔ API.** Everything from the browser is untrusted. Authentication is
   by session cookie plus CSRF token; authorization is decided per request on the
   server.
2. **Activity frame ↔ learner app.** Course activity code runs in a sandboxed,
   opaque-origin iframe and talks to the app only through a capability broker.
3. **External agent ↔ API.** A learner-issued, scoped bearer token; no cookies.
4. **Supervisor / Temporal ↔ API.** A shared service token on internal `/v1/*`
   routes; Temporal itself is reached only on loopback.
5. **API ↔ PostgreSQL.** Loopback or Unix socket; optional least-privilege runtime
   role.
6. **API ↔ providers.** Outbound HTTPS to fixed provider origins; responses are
   untrusted.
7. **API ↔ Docker.** Learner code runs in a pinned, network-less container.
8. **Course packages and installers ↔ API.** Uploaded or fetched archives are
   untrusted input to a validator; nothing in them is executed.
9. **Network path.** Loopback by default; a tailnet origin (WireGuard-encrypted) or,
   with the insecure-origin switch, plain HTTP across a LAN.
10. **Operator ↔ host files.** `config.json`, the vault directory, `temporal.db` and
    backups are owner-only files on the host.

## Threats, mitigations and residual risk

### Authentication

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Password guessing | scrypt N=2^17, r=8, p=1 (`services/api/src/passwords.ts:14-17`); 12–1024 characters (`passwords.ts:8-9`); throttle of 10 failures per login name and 100 per client address in 15 minutes, counted before the check under an advisory lock, 429 with `Retry-After` (`auth.ts:21`, `auth.ts:117-133`); the same throttle covers passkey sign-in and password change | The API sets no `trustProxy`, so the address is the socket peer (`auth.ts:134`). Behind `tailscale serve` or any reverse proxy every client shares one address bucket: 100 failures from anyone lock everyone out for 15 minutes |
| Account enumeration by timing | A dummy scrypt hash is computed for unknown names (`auth.ts:70`, `auth.ts:160-166`) | — |
| Stolen session cookie | `course_session` is HttpOnly, SameSite=Strict, Path=/ (`auth.ts:81-84`); Secure on https origins (`main.ts:111`); only SHA-256 digests of 32-byte tokens are stored (`auth.ts:101-106`); absolute lifetime 12 h by default, at most 720 h (`auth.ts:34`, `auth.ts:40-48`); logout revokes (`auth.ts:212-218`); a password change revokes other sessions (`passwords.ts:109-110`); removing the last membership revokes all sessions (`people-routes.ts:310-315`) | No idle timeout. An operator may allow 30-day sessions. Expired session rows are never purged. On plain-HTTP origins cookies are not Secure (see [Network path](#network-path-tailnet-and-the-insecure-origin-switch)) |
| One-time sign-in codes leaked | Off unless `AUTH_LOGIN_CODES=enabled` (`auth.ts:49-54`); 32 random bytes, SHA-256 at rest, 10-minute expiry (`auth.ts:56-60`); single use under a row lock (`auth.ts:139-154`); admins may issue them only for accounts that belong to no other workspace (`people-routes.ts:75-79`) | A code is a bearer credential while valid; the bootstrap CLI prints it to the operator's terminal |
| Passkey misuse | Only on an https domain origin or `http://localhost`, never an IP (`passkeys.ts:18-26`); user verification and resident keys required (`passkeys.ts:150`, `passkeys.ts:203`); 5-minute single-use challenges, at most 20 passkeys per user and 50 open challenges per address (`passkeys.ts:29-34`); registration needs a session under 10 minutes old or the password (`passkeys.ts:121-126`); signature counter checked under a lock (`passkeys.ts:235`) | Passwords stay enabled next to passkeys; there is no other second factor |

### Cross-site requests and origin policy

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| CSRF on state-changing requests | Every authenticated non-GET/HEAD/OPTIONS request needs an `Origin` exactly matching a trusted origin and an `X-CSRF-Token` whose digest matches the session's, compared in constant time (`auth.ts:93-98`); sign-in routes need a trusted `Origin` before a session exists (`auth.ts:140`, `auth.ts:157`); SameSite=Strict cookies | GET routes rely on SameSite=Strict and must stay side-effect free |
| Untrusted origins admitted | `PUBLIC_ORIGIN` without credentials or path; plain HTTP only for a loopback origin on a loopback listener (`main.ts:36-42`); `ADDITIONAL_ORIGINS` at most 8 exact origins, no wildcards, https only except an `http://` Tailscale address with an explicit port (`services/api/src/origins.ts:5`, `origins.ts:44-71`) | — |
| Cross-origin reads | No CORS plugin is registered (`server.ts:102-105`); the browser's same-origin default applies | — |
| DNS rebinding against loopback | The `Host` header never admits a request; it only selects cookie attributes and the passkey relying party (`origins.ts:76-81`, `origins.ts:98-103`) | There is no `Host` allowlist, so a rebound page can read the unauthenticated GETs (`/health`, `/auth/options`). They reveal nothing sensitive |

### Authorization and tenant isolation

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| A user acts beyond their role | One permission matrix for owner, admin, author, instructor, reviewer, observer, support_observer, service and learner (`services/api/src/course-access.ts:8-99`); course-scoped members get permissions only through an unrevoked, unexpired grant checked per request (`course-access.ts:101-131`); the shared resolvers `resolveRole`/`permitCourse`/`workspaceRole`/`enrollmentRole` (`course-access.ts:124-188`); admins cannot manage owner, admin or service roles and nobody changes their own role (`people-routes.ts:30`, `people-routes.ts:53-57`, `people-routes.ts:246`) | — |
| Reading another learner's or workspace's records | Enrollment reads require an active membership; staff need the staff flag and an owner, admin or instructor role on that course; anyone else gets 404 (`repository.ts:43-58`); erased enrollments return 410 (`repository.ts:52`). All SQL is parameterised and filtered by `workspace_id` / `user_id` | Isolation is enforced in application code only. PostgreSQL row-level security is not used, so one missed filter in a new route is a cross-tenant leak with no database backstop |
| Staff misuse of learner data | View-as-learner is owner/admin only, read-only, creates no learner session, and is recorded in the append-only `staff_learner_views` table and as an event the learner sees (`learner-view.ts:60-98`); the learner's private conversation, self-notes and learner model are withheld from staff (`learner-privacy.ts:1-11`, `learner-privacy.ts:36`, `learner-privacy.ts:152`); staff exports omit them (`data-lifecycle.ts:90-113`) | Owners and admins can still export a learner's record on request; that is audited but not prevented |
| Credit granted without evidence | Server-side, versioned evidence and transactional receipts decide progression (AGENTS.md); 409 `EVIDENCE_REQUIRED` when a gate has not passed (`assessment-routes.ts:206`); model output, probes and activity coverage never grant mastery (`supervisor-tool-catalog.ts:61`, `activity-routes.ts:87`); rubric suggestions need a deterministic check or a person (`conversation-confirmation.ts:14`); independence is downgraded by any assistance (`independence.ts:2-8`) | — |

### Provider keys and provider output

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Provider key disclosure | Keys are sealed with AES-256-GCM under a 32-byte vault key, with workspace, revision and credential name as associated data (`services/api/src/key-vault.ts:21-63`, `provider-setup.ts:77-78`); the vault directory must be absolute, owner-owned 0700, the key file 0600, one hard link, opened with `O_NOFOLLOW` (`key-vault.ts:65-126`); the read API returns names and `configured: true` only, to owners and admins (`provider-setup.ts:184-200`); plaintext is never returned, logged or put in a URL (`provider-setup.ts:144-150`); Fastify logging is off (`server.ts:102`) and errors return codes only (`server.ts:114-126`) | The vault key sits on the same host as the database, and backups carry it. The pilot's optional `providerCredentials` are plaintext in `config.json` (0600) and are passed to the API as environment variables |
| Malicious or oversized provider responses | Bounded response reads (`packages/providers/src/http.ts:59-70`); error bodies capped at 16 KiB with only an allowlisted code extracted (`http.ts:101-108`); redirects refused (`http.ts:156`); provider origins come from code, not configuration (`http.ts:93`) | — |
| Runaway spend | Workspace and enrollment budgets are locked and checked for every paid job, media included (`supervisor-bridge.ts:84`, `supervisor-bridge.ts:141-158`); per-job allowance defaults of 100,000 µUSD and 10,000 tokens (`provider-setup.ts:25-40`); a zero allowance is refused (`supervisor-bridge.ts:63-64`); gateway concurrency 1–8, default 2 (`provider-gateway.ts:30`); shared generation budgets default to zero | No per-learner message-rate limit on the companion; spend budgets are the only cap |

### Prompt injection and generated content

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Learner, course or retrieved text steering the model | Text is labelled as data, not instructions, in the context capsule (`services/api/src/context-capsule.ts:29-30`) and the agent-tool instructions (`agent-tools-routes.ts:291`); the tool loop is limited to 2–8 rounds and bounded input sizes (`provider-composition.ts:16-17`); older tool results are dropped first (`supervisor-tool-loop.ts:189-192`); at most two generated candidates and two research selections (`supervisor-tool-loop.ts:259-283`); fixed refusal reasons and no partial plans (`output-refusal.ts:3-21`); the brief states model output cannot grant tool, grading or paid authority (`supervisor-tool-loop.ts:186`); plans are verified before they are applied (`server.ts:334`) | A successful injection can still produce misleading teaching text or companion replies that reach a learner. There is no output-content filter. It cannot grant credit, call unlisted tools or spend beyond the budget |
| Answers written by an AI and submitted as the learner's | An answer that reproduces a sentence of 60 or more characters from a companion reply is refused with `AGENT_AUTHORED_ANSWER` (`assessment-routes.ts:41-48`, `assessment-routes.ts:173`) | A heuristic against Core's own companion only. Paraphrases, or text from an outside model pasted in, are not detected |

### Generated and learner code

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Learner code escaping or attacking the host | Digest-pinned images per architecture (`packages/sandbox/src/index.ts:15-19`) with `@sha256:` required (`index.ts:95`) and `--pull=never`; `--network=none`, `--read-only`, `--cap-drop=ALL`, `no-new-privileges`, uid 65532, 128 MiB memory and no swap, 0.5 CPU, 32 pids, 64 files, no core dumps, a 16 MiB `noexec` tmpfs and a read-only work mount (`index.ts:80-83`); 5 s default timeout and 64 KiB output cap (`index.ts:93-98`); readiness checks for a Linux host with memory, pids and seccomp support (`index.ts:112-124`); the reference grader stays outside the container (SECURITY.md) | The API needs the Docker daemon, which is root-equivalent on the host. Isolation is runc with the default seccomp profile, with no gVisor or user namespaces. A kernel escape compromises the host |
| Untrusted code in the application process | Course packages and provider output are never executed in the API (`course-package.ts:9`); activity scripts come only from extensions installed on the host and checked by integrity at startup (`activity-runtime.ts:59-64`, `main.ts:80`); visuals are declarative expression trees with numeric and evaluation budgets (`packages/visuals/src/expression.ts:3-27`) and their build is scanned for markup or script injection (`visuals-identity.ts:58`) | — |

### Sandboxed activity frames

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Activity code reading the learner's session or calling the API | `sandbox="allow-scripts"` without `allow-same-origin` (an opaque origin), `allow=""`, `referrerPolicy=no-referrer` (`apps/learner/src/connected/ActivityBlock.web.tsx:10`, `ActivityBlock.web.tsx:239-240`); frame CSP `default-src 'none'`, hash-pinned scripts, `connect-src 'none'`, no forms, frames or workers, `sandbox allow-scripts` (`services/api/src/activity-runtime.ts:579-583`); CORP and COOP same-origin, `X-DNS-Prefetch-Control: off` and a restrictive Permissions-Policy (`activity-routes.ts:112-124`); a browser test shows network hints from the frame never connect (`services/api/browser/activity-hints.spec.ts`) | The frame is served from the API's own origin under `/api/activity-frames/…`. Isolation depends on the iframe sandbox and CSP; there is no separate origin to fall back on |
| Forged messages between frame and app | A fresh nonce in the URL fragment; the hello must come from that frame's window with that nonce; one `MessageChannel` port is handed over; navigation away stops the frame (`ActivityBlock.web.tsx:195-233`); a broker limits the frame to granted capabilities and payload sizes (`ActivityBlock.web.tsx:197-206`); per-activity event-rate and state budgets answer 429 (`activity-routes.ts:25-32`, `activity-routes.ts:220`) | The initial message is posted with target `"*"` because the origin is opaque. It carries no secrets |

### Supervisor and Temporal

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Forged calls to the bridge or provider gateway | `/v1/supervisor/bridge` and `/v1/*` gateway routes require the service token as a Bearer header, compared by SHA-256 with `timingSafeEqual` (`supervisor-bridge.ts:715-725`, `provider-gateway.ts:28-36`); the job's workspace must be listed in `SUPERVISOR_WORKSPACE_IDS`, and an empty list denies everything (`provider-gateway.ts:43`, `supervisor-bridge.ts:37-38`); 256 KiB body limit; the pilot requires a 32–128 character token (`deploy/local/pilot.mjs`, `loadConfiguration`) | The internal routes share the public listener and are protected only by the token. One token serves both the bridge and the gateway |
| Tampering with workflows through Temporal | The pilot runs `temporal server start-dev --ip 127.0.0.1` (`deploy/local/pilot.mjs`, `servicePlan`); the supervisor requires TLS for a non-local Temporal address or an API key (`services/supervisor/src/config.ts:21-25`) and https or loopback http for the API URL (`services/supervisor/src/bridge.ts:62-68`) | The Temporal dev server and its UI have no authentication; any local process can use them. Workflow history keeps payloads after a learner's erasure until its own retention ends (`data-lifecycle.ts:220`) |

### PostgreSQL

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| SQL injection or schema changes from the API | Parameterised queries throughout; with `migrationDatabaseUrl` the owner connection migrates and grants the runtime role DML only, then the API refuses to serve if its role is a superuser, can CREATE or owns tables (`services/api/src/db-roles.ts:6-31`, `main.ts:57-68`) | The role split is optional; without it the API runs as the owner |
| Remote database access | The pilot accepts only a loopback host or Unix socket (`deploy/local/pilot.mjs`, `loadConfiguration`) | Database passwords may sit in `config.json` and process environments; only the backup tool refuses a password in a URL (`deploy/local/backup.mjs`, `connection`) |

### Course packages and installers

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Malicious archive (path traversal, links, bombs) | ustar only; links, devices, absolute paths, `\` and `..` are refused (`services/api/src/ustar.ts:4-6`, `ustar.ts:25`, `ustar.ts:47`, `ustar.ts:66-68`); 200 members, 32 MiB per member, 128 MiB total, 64 MiB compressed (`course-package.ts:19-24`); each member's size and SHA-256 are listed in a descriptor (`course-package.ts:1-13`) | — |
| A package that runs code or swaps grading | The manifest is recompiled with Core's own pinned SDK compiler and must match `courseDigest` (`course-package.ts:155-165`); nothing in a package is executed and host-requirement files are compared by digest only (`course-package.ts:9`); extensions must exactly match installed builds by version and integrity (`extension-identity.ts:1-15`); only owners and admins install, and the body is read after that check (`course-package-routes.ts:90-91`, `course-package-routes.ts:302-312`) | — |
| Fetching from attacker-chosen hosts | GitHub releases only, from an allowlist of hosts; at most 5 redirects, each re-checked; no credentials sent; bounded reads (`course-package-source.ts:1-10`, `course-package-source.ts:32-33`, `course-package-source.ts:76-118`); `COURSE_PACKAGE_REMOTE_FETCH=off` disables it (`course-package-source.ts:14-18`) | — |
| A compromised publisher or release | A sibling `.sha256` asset is verified when the release has one (`course-package-source.ts:181-198`) | Packages carry no signature or provenance. The optional checksum comes from the same release, so it detects corruption, not a malicious publisher. Automatic updates trust whatever the publisher releases next (`server.ts:320-332`) |
| Directory installs escaping their folder | `COURSE_PACKAGE_DIRECTORIES` entries are resolved with `realpath`, `..` is refused, and files are opened with `O_NOFOLLOW` inside the directory (`course-package-directory.ts:5-6`, `course-package-directory.ts:37-60`) | — |

### Network path: tailnet and the insecure-origin switch

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Eavesdropping on remote use | The API always listens on `127.0.0.1` (`deploy/local/pilot.mjs`, `servicePlan`); without the switch the only `http://` additional origin allowed is a literal Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) with a port (`origins.ts:7-16`, `origins.ts:50-53`; pilot: `tailscaleAddress`, `additionalOrigin`), whose traffic WireGuard encrypts; a tailnet HTTPS name with `tailscale serve` is documented as the alternative | Anyone on the tailnet who can reach the node can reach the sign-in page |
| Plain HTTP over a LAN | `ALLOW_INSECURE_ORIGINS` must be exactly `true` or `false` (`origins.ts:26-31`); it only widens which exact `http://` origins may be listed, and matching, CSRF and SameSite are unchanged (`origins.ts:18-24`); the API logs a warning at start (`main.ts:125`) and the admin app shows a notice; http origins get no Secure cookies (`auth.ts:80-83`) and no passkeys (`passkeys.ts:24`); the pilot will not turn the check back on while insecure origins are still listed (`manageSecurity`) | With the switch on, passwords, session cookies and CSRF tokens cross the LAN in cleartext. Anyone who can sniff that network can take over sessions. This is an explicit operator choice |

### External agent-tool tokens

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| A stolen or over-broad agent token | Only the learner can issue one, for one of their own enrollments; staff get 404 (`agent-tools-routes.ts:320-327`, `agent-tools-routes.ts:335-353`); `ccat_` plus 32 random bytes, SHA-256 at rest, shown once (`agent-tools-routes.ts:22-25`, `agent-tools-routes.ts:343-347`); explicit scopes, 1–90 day expiry, at most 5 active grants per enrollment (`agent-tools-routes.ts:46-51`, `agent-tools-routes.ts:318-319`); every call re-checks digest, revocation, expiry, erasure and scope, with one uniform 401 (`agent-tools-routes.ts:113-129`, `agent-tools-routes.ts:228`); cookies and query-string tokens are not accepted (`agent-tools-routes.ts:30-31`); 60 calls/min per grant, 120 per enrollment, 2 proposals/min (`agent-tools-routes.ts:50-51`); the learner can revoke at once (`agent-tools-routes.ts:365-378`) | A leaked token reads the granted scopes until it expires or is revoked. The failed-authentication throttle (30/min per address, `agent-tools-routes.ts:93-109`) is in memory, per process and per socket address (the proxy caveat above applies) |
| An agent writing the learner's record | Reads return a minimal projection that omits excluded evidence (`agent-tools-routes.ts:32-34`); the only write, `propose_intervention`, creates a suggestion that waits for the learner and never grants credit (`agent-tools-routes.ts:35-38`, `agent-tools-routes.ts:76-77`) | — |

### Telemetry and logs

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Learner text or secrets in logs or traces | Telemetry is off unless configured; every attribute passes an allowlist with value patterns (`services/supervisor/src/telemetry.ts:10-20`, `telemetry.ts:139-151`); HTTP spans carry the route template, method and status (`services/api/src/telemetry.ts:8-12`); browser trace headers are ignored (`telemetry.ts:20-23`); provider spans carry model, provider, token counts and outcome only (`telemetry.ts:42-61`); Fastify logging is off and auth routes are silent (`server.ts:102`, `auth.ts:136-212`); the pilot log keeps fixed codes and discards raw child output (`deploy/local/runtime.mjs:210-221`); the OTLP endpoint must be https or loopback http without credentials (`deploy/local/pilot.mjs`, `telemetryConfiguration`) | OTLP headers (for example a collector token) sit in `config.json` |

### Supply chain

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Malicious or swapped dependencies | `npm run audit:public` requires SHA-512-pinned npmjs tarballs or the exact SDK release asset, lockfile v3 and registered local modules (`scripts/public-policy.mjs:89-126`, `scripts/modules.mjs:83-84`); `.npmrc` may only name the npm registry (`public-policy.mjs:55-64`); installs run `npm ci --ignore-scripts` (`scripts/orchestrate.mjs:187`) | No vulnerability audit of dependencies, no SBOM and no artifact signing. Install scripts are disabled only through the orchestrator; a manual `npm ci` in a component runs them |
| Compromised CI | Actions are pinned by commit SHA, the token is `contents: read`, checkout credentials are not persisted, and no secrets reach pull requests (`.github/workflows/ci.yml`, CONTRIBUTING.md) | — |
| Swapped runtime binaries | The sandbox image is pinned by digest (above); the Temporal CLI must be checksum-verified by the operator | The Temporal checksum is a documented operator step, not enforced by the launcher |

### Backups and host files

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Backup disclosure | Backups are owner-only (0700/0600) and their files are re-hashed against the manifest on every verify, prune and restore (`deploy/local/backup.mjs`, `verifyManifest`); optional [age encryption](../deploy/local/README.md#encrypting-backups-with-age-optional) to configured public recipients, with the database dump streamed into `age` so no plaintext dump is written, and private keys refused in configuration (`backupAgeRecipientsConfiguration`) | Encryption is off by default. The manifest stays readable (versions, table names, row counts, file sizes). Unencrypted backups hold learner data, the service token and the vault key in the clear. Erasures after a backup are not applied to it |
| Tampered backup restored | Digest checks on every file; age authenticates ciphertext, so a rewritten manifest digest still fails decryption; restore drills restore into a new database and compare row counts and migrations (`verifyBackup`) | The manifest itself is not signed |
| Pilot state tampering | `config.json`, the vault, the control socket and owner records must be owner-only, single-link, non-symlink files (`deploy/local/runtime.mjs:16-53`); the control socket stops only the launcher's own children | Anyone with the operator's account controls the pilot |

### Availability

| Threat | Mitigation in code | Residual risk |
| --- | --- | --- |
| Request floods | Body limits: 1 MiB default, 16 MiB for releases, 256 KiB for the bridge (`server.ts:102`, `server.ts:156`); event streams 4 per account and 200 per process (`event-stream.ts:14-22`); per-activity rate limits; login and agent-token throttles | No global per-address request rate limit. The pilot is one host with no redundancy; see the [availability targets](../deploy/local/README.md#availability-recovery-targets-and-degraded-modes) |

### Security headers

Every API response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and, unless an activity frame sets its own stricter policy,
`default-src 'self'; script-src 'self' https://www.youtube.com; style-src 'self' 'unsafe-inline'; … frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`
(`services/api/src/server.ts:108-113`). Static files deny dotfiles and serve no indexes
(`server.ts:343-352`).

Residual: the API sends no HSTS (that falls to the TLS proxy), no COOP/CORP or
Permissions-Policy on app pages, and allows inline styles and the YouTube iframe API
script.

## Summary of residual risks

The most significant, in rough order:

1. **Host compromise is total.** Database, vault key, service token, Temporal
   history and backups are all on one host under one account.
2. **Tenant isolation is application-level only.** No row-level security backs up
   the shared authorization helpers.
3. **The insecure-origin switch sends credentials in cleartext** on the LAN when the
   operator turns it on.
4. **Course packages are unsigned.** Authenticity rests on the GitHub account and
   release, not on a key.
5. **Throttles key on the socket address.** Behind a proxy they become a shared
   lockout, and the agent-token throttle is in memory.
6. **The code sandbox relies on runc and the host kernel**, and the API holds
   Docker daemon access.
7. **Generated text can mislead learners.** It cannot grant credit, but there is
   no content filter.
8. **Backups are unencrypted unless age recipients are configured**, and erasure
   does not reach existing backups or Temporal history.
9. **Supply-chain controls are pinning and integrity only.** There is no SBOM,
   signing or vulnerability audit.

This document is reviewed when a trust boundary changes: a new external integration,
a new credential type, a change to the sandbox, the package format or the network
exposure.
