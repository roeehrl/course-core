# Self-hosting on a Linux server with Docker

This directory runs Course Core on one Linux server (or VM) with Docker Engine and the
Compose plugin. It is the general-purpose alternative to the macOS pilot in
[`deploy/local`](../local/README.md), and it is what CI brings up on every pull request.

| Service | What it does | Reachable from |
| --- | --- | --- |
| `proxy` | Caddy: HTTPS with an automatically renewed certificate, HTTP to HTTPS redirect | The internet (ports 80 and 443) |
| `api` | The Course Core API, which also serves the learner app at `/` and administration at `/admin/` | Only the proxy |
| `db` | PostgreSQL 17 | Only the API |
| `temporal`, `worker`, `dispatcher` | Optional supervision (companion replies, follow-ups). Off unless you enable the `supervision` profile | Nothing: Temporal listens on loopback inside its own container |

It is a single-host setup with no standby, like the pilot. Everyone signs in: there is no
anonymous course access, and the API refuses to start on a public address without HTTPS.

## What you need

- A Linux server with Docker Engine 24 or later and the Compose plugin (`docker compose version`).
  About 2 CPU cores, 4 GB of memory and 20 GB of disk for a small course.
- A DNS name pointing at the server (for example `course.example.org`), with ports 80 and
  443 open to the internet so Caddy can obtain the certificate. On a private network
  without public DNS, see [Private networks](#private-networks).
- A clone of this repository at a release tag (`git checkout v0.1.50`, for example).

## First start

```sh
cp deploy/docker/.env.example deploy/docker/.env
chmod 600 deploy/docker/.env
# Edit .env: set COURSE_HOSTNAME and POSTGRES_PASSWORD (openssl rand -hex 32).
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/.env up -d --build --wait
```

`.env` holds the database password and, with supervision, the service token. It is ignored
by git and excluded from the image build. Never commit it or paste it into an issue.

The first build compiles every module and takes a few minutes. `--wait` returns once the
database, API and proxy report healthy. Open `https://<COURSE_HOSTNAME>/` to check.

### Create the owner account

```sh
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/.env \
  exec api node dist/bootstrap-cli.js <workspace-slug> <your-login> "<Your name>" --password
```

It asks for the owner password twice without echoing it and prints the new workspace ID.
Then sign in at `https://<COURSE_HOSTNAME>/admin/`. Sign-in options, passkeys and session
length work as described in
[Sign-in settings and passwords](../local/README.md#sign-in-settings-and-passwords); set the
matching variables (for example `AUTH_LOGIN_CODES`, `SESSION_HOURS`) under the `api`
service. Installing courses works as in
[Installing courses from packages](../local/README.md#installing-courses-from-packages).

## Private networks

On a network without public DNS (a lab, a VPN or a tailnet), set
`CADDY_GLOBAL_OPTIONS=local_certs`. Caddy then issues the certificate from its own
authority. Install that authority's root certificate on the devices that will use the
course, so browsers trust it:

```sh
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/.env \
  cp proxy:/data/caddy/pki/authorities/local/root.crt ./course-root.crt
```

The root certificate is public; the matching key stays in the `proxy-data` volume. To bind
the proxy to one interface only (for example a VPN address), set `COURSE_BIND_ADDRESS`.

## Supervision (optional)

Supervision runs the companion and follow-up jobs. Without it, lessons, checks, grading
and progress all work; supervised work waits safely in the outbox.

1. Add `SUPERVISOR_HOST_TOKEN` (`openssl rand -hex 32`) and `SUPERVISOR_WORKSPACE_IDS`
   (the workspace ID printed by the bootstrap command) to `.env`.
2. With `CADDY_GLOBAL_OPTIONS=local_certs`, also set
   `COURSE_EXTRA_CA_CERTS=/proxy-ca/root.crt` so the supervisor trusts the proxy.
3. Start with the profile, and keep using it for every later command:

```sh
docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/.env --profile supervision up -d --build --wait
```

The worker and dispatcher reach the API through the proxy by its public name, over HTTPS,
and share the Temporal container's network so Temporal itself is never exposed. Model
providers are configured in administration, as in the pilot; see
[`services/api/PROVIDER_SETUP.md`](../../services/api/PROVIDER_SETUP.md).

## Keep-alive and degraded modes

- Every long-running service has `restart: unless-stopped` and a health check. If the API,
  the database, the proxy or a supervision process exits, Docker starts it again; the
  API waits for a healthy database first. CI proves this: it stops the API process and
  checks that it comes back healthy with its data.
- Enable Docker at boot (`sudo systemctl enable docker`) so the stack starts after a reboot
  without anyone signing in.
- A container that is running but hung is reported `unhealthy` by `docker compose ps`.
  Docker does not restart unhealthy containers by itself; check `docker compose ps`
  from your monitoring, or restart the service by hand.
- What learners and staff see when a provider, Temporal, telemetry or the database is
  down is the same as in the pilot: see
  [Degraded modes](../local/README.md#degraded-modes). The difference here is that an API
  exit after a database restart is recovered by the restart policy.

## Backups and restore

Stop the services that write, take the dump, then start them again:

```sh
C="docker compose -f deploy/docker/compose.yaml --env-file deploy/docker/.env --profile supervision"
$C stop api worker dispatcher temporal
$C exec -T db pg_dump --format=custom -U course course_core > backup-$(date -u +%Y%m%dT%H%M%SZ).pgdump
$C cp temporal:/data/temporal.db ./temporal.db   # only with supervision
$C start temporal api worker dispatcher
```

The dump contains learner records. Keep it on encrypted, private storage, for example
encrypted with `age` as in [Encrypting backups with age](../local/README.md#encrypting-backups-with-age-optional),
and never in a repository. Prove each backup restores: create a scratch database with
`$C exec db createdb -U course restore_check`, restore into it with
`pg_restore --no-owner --no-privileges --exit-on-error -U course -d restore_check`
(through `$C exec -T db`), compare row counts with the live database, then drop it.
Recovery targets and the reasoning behind a daily backup are in
[Availability, recovery targets and degraded modes](../local/README.md#availability-recovery-targets-and-degraded-modes).
If you enable the optional object store (`COURSE_ARTIFACT_STORE=s3`), back up that bucket
separately.

## Upgrading

1. Take and verify a backup (above).
2. `git fetch --tags && git checkout <new-release-tag>`.
3. `docker compose ... up -d --build --wait` (with `--profile supervision` if you use it).

The API applies new database migrations when it starts. Migrations only move forward: to
go back to the previous release, check out its tag and restore the backup you took in
step 1 into a fresh database volume. Read [RELEASES.md](../../RELEASES.md) before upgrading.

## Least-privilege database role

By default the API connects as the database owner, which also runs migrations. To split
them, create a second login role, point `DATABASE_URL` at it and set
`MIGRATION_DATABASE_URL` to the owner connection, as described in
[Least-privilege database role](../local/README.md#least-privilege-database-role).
Use a `compose.override.yaml` next to `compose.yaml` for this and for any other local
change, so upgrades do not conflict with your edits.

## Telemetry

OpenTelemetry export is off by default. Add the standard `OTEL_*` variables to the `api`
service (and to the supervision services) as described in
[OpenTelemetry](../local/README.md#opentelemetry-optional).

## Network layout

The services share one private network. The proxy has a fixed address (default
`172.30.89.10`), and the API trusts `X-Forwarded-For` only from that address, so sign-in
throttling sees each client's real address. If `172.30.89.0/24` is already used on your
host, change `COURSE_SUBNET`, `COURSE_DYNAMIC_RANGE` and `COURSE_PROXY_ADDRESS` together.

## How this is tested

- `deploy/docker/compose.test.mjs` (part of `npm run test:lifecycle`) checks the file
  itself: pinned image digests, only the proxy publishes ports, restart policies and health
  checks, no secrets in the compose file.
- `deploy/docker/smoke.test.mjs` (`npm run test:self-host`, run by the required
  `Sandbox / real Docker Linux` CI check) builds the image and starts the stack under its
  own throwaway project. It creates an owner with the bootstrap command, then over HTTPS
  trusting only the proxy's own root certificate it checks health, the learner and
  administration pages, that anonymous and wrong-password requests are refused, that the
  owner signs in with Secure cookies and sees the workspace, that plain HTTP redirects to
  HTTPS, that the database port is not published, and that the API comes back healthy with
  its data after its process exits. It removes everything it created, also on failure.

The supervision profile is not started in CI. It was brought up by hand on Docker with a
private hostname and `local_certs`: Temporal reported serving and the worker reached the
API over HTTPS through the proxy. A real public certificate, real provider calls and
long-running operation on your server are not covered by these tests.
