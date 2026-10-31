# Deploy Course Core

This is the recommended way to run Course Core: Docker Compose on one machine. It works the
same on a Linux server, on a Mac with Docker Desktop or Colima, and on a private box that is
reachable only over a Tailscale tailnet. One script, `deploy/docker/core.sh`, does every
operation. (The macOS-native pilot in [`deploy/local`](../local/README.md) is still supported,
but it is no longer the first choice.)

What runs:

| Service | What it does | Reachable from |
| --- | --- | --- |
| `proxy` | Caddy: HTTPS (a public certificate, or its own authority for private names) | The ports you publish |
| `api` | The API, which also serves the learner app at `/` and administration at `/admin/` | Only the proxy |
| `db` | PostgreSQL 17 | Only the API |
| `sandbox-gate` | Starts the locked-down containers that grade learners' code (see [Code grading](#code-grading)) | Only the API, through a socket |
| `temporal`, `worker`, `dispatcher` | Supervision: the tutor's replies and follow-ups | Nothing: Temporal listens on loopback in its own container |

Everyone signs in; there is no anonymous course access. It is one machine with no standby.

## 1. What you need

- Docker with the Compose plugin (`docker compose version` prints v2 or later; Docker Engine 26
  or later, which every current Docker Desktop and Colima has).
- Git, to get the code: `git clone https://github.com/roeehrl/course-core && cd course-core &&
  git checkout <release tag>` (for example `v0.1.60`).
- Node 22 or later is optional. Without it, `core.sh` runs its commands inside the Course Core
  image.

Memory: give Docker at least **6 GB** (4 GB is the minimum for a small course; the first build
needs the most). Disk: 20 GB free.

### On a Mac

- **Docker Desktop**: Settings > Resources > Memory: 6 GB or more. Nothing else to change.
- **Colima**: `colima start --cpu 4 --memory 8 --disk 60` (or edit `~/.colima/default/colima.yaml`
  and restart). Keep the checkout under your home folder, which Colima shares with Docker.

### On Linux

Install Docker Engine and the Compose plugin from Docker's packages
(https://docs.docker.com/engine/install/), then `sudo systemctl enable --now docker`, so the course
starts again after a reboot. Run `core.sh` as a user in the `docker` group, or with `sudo`.

## 2. First start

```sh
deploy/docker/core.sh up
```

The first time, this creates `deploy/docker/.env` (owner-only, ignored by git) from
[`.env.example`](.env.example) with two generated secrets, builds the image (several minutes,
once) and starts everything, supervision included. It returns when every service is healthy.

The default settings are for a **private machine**: the course listens on this machine only, at
`https://localhost:8443`. For a **public server**, edit `.env` first:

```sh
COURSE_HOSTNAME=course.example.org   # a DNS name that points at this server
COURSE_BIND_ADDRESS=0.0.0.0
COURSE_HTTP_PORT=80
COURSE_HTTPS_PORT=443
```

Ports 80 and 443 must reach the server; Caddy obtains and renews the certificate itself.

## 3. Create the owner account

```sh
deploy/docker/core.sh bootstrap <workspace-slug> <your-login> "<Your name>"
```

It asks for the owner password twice and never echoes it. It saves the workspace for
supervision in `.env`, restarts the API and the supervisor with it, and prints the workspace ID.
Sign in at `https://<your host>/admin/`. To set or reset a password later:

```sh
deploy/docker/core.sh set-password <workspace-slug> <login>
```

## 4. Private and tailnet use

On a private machine the course is at `https://localhost:8443`, with a certificate from Caddy's
own authority. Browsers warn about it until you trust that authority:
`deploy/docker/core.sh ca-cert` writes it to `deploy/docker/.ops/proxy-root.crt` (it is public;
its key stays in the proxy volume); add it to your keychain or browser.

**The simplest way to reach it from your other devices is Tailscale.** The proxy also serves
plain HTTP on `127.0.0.1:8380`, on this machine only, for `tailscale serve` to forward:

- **HTTPS with the machine's tailnet name** (recommended; passkeys work). Enable MagicDNS and
  HTTPS certificates in the tailnet admin console, then:

  ```sh
  tailscale serve --bg --https=443 http://127.0.0.1:8380
  tailscale serve status    # shows https://<machine>.<tailnet>.ts.net
  ```

  Add that exact origin to `.env` and apply it:

  ```sh
  COURSE_ADDITIONAL_ORIGINS=https://<machine>.<tailnet>.ts.net
  deploy/docker/core.sh up
  ```

- **Plain HTTP by tailnet IP address.** `tailscale serve --bg --tcp=8380 tcp://127.0.0.1:8380`,
  then `COURSE_ADDITIONAL_ORIGINS=http://<100.x.y.z>:8380` (from `tailscale ip -4`) and
  `core.sh up`. Plain `http` is accepted only for a literal Tailscale address, whose traffic
  WireGuard encrypts; such a page gets no passkeys and no `Secure` cookies.

The rules are the pilot's: see
[Using the pilot from your Tailscale tailnet](../local/README.md#using-the-pilot-from-your-tailscale-tailnet),
including the insecure-origin switch (`COURSE_ALLOW_INSECURE_ORIGINS=true`) for LAN `http`
origins and its risks. Never use `tailscale funnel`, which publishes the course to the internet.
Requests through the forwarder all come from one address, so sign-in throttling treats the
tailnet as one source (each username keeps its own limit).

## 5. Install a course

In administration, **Install course** takes a course package by upload or from a public GitHub
release link (see the root README, "Installing a course").

Courses that grade code with hidden test cases, or bring teaching verifiers, need files on this
host. Put them in `deploy/docker/course-files/` (ignored by git and by the image build; set
`COURSE_FILES_DIR` for another directory), list them in `.env`, and run `core.sh up`:

```sh
COURSE_CODE_FIXTURES=search-lab.code-fixtures.json
COURSE_TEACHING_VERIFIERS=worked-verifier.json
```

Names are plain file names in that directory. The API copies them into private memory at start;
on Linux they must be readable by user ID 1000 (`sudo chown 1000 deploy/docker/course-files/*`,
or `chmod 644`). A missing or unreadable file stops the API with `startup.course_files_failed` and
the file's name in `core.sh logs api`. Courses that bring their own hidden cases in the package
need nothing here: that is on by default (`COURSE_SUPPLIED_CODE_FIXTURES=on`).

A course repository's own install script (for example `scripts/install-pilot-course.mjs`) checks
that its `--origin` is on loopback. Use `https://localhost:8443` with the proxy's authority:
`NODE_EXTRA_CA_CERTS=deploy/docker/.ops/proxy-root.crt node scripts/install-pilot-course.mjs
--origin https://localhost:8443 --bootstrap <core>/deploy/docker/.ops/bootstrap.json ...`
(`core.sh bootstrap` writes that `bootstrap.json`, which holds the workspace ID only). On a public
server that check refuses the public origin, and `https://localhost` is not an origin the API trusts
there: install the course package from administration instead.

Model providers are configured in administration; see
[`services/api/PROVIDER_SETUP.md`](../../services/api/PROVIDER_SETUP.md). Exact clips and the
frame check work out of the box: the image has `ffmpeg`, `ffprobe` and `rsvg-convert`.

## 6. Every day

```sh
deploy/docker/core.sh status          # health of every service and the running version
deploy/docker/core.sh logs [api] [-f] # recent logs; logs rotate at 3 x 10 MB per service
deploy/docker/core.sh backup          # an online backup, no downtime
deploy/docker/core.sh restore-drill   # restore the newest backup into a scratch database and verify it
```

`backup` writes `deploy/docker/backups/snapshot-<time>-<id>/`: the database from one consistent
snapshot, the Temporal store (SQLite's online backup), the sealed provider vault and `.env`, with
a manifest of digests and row counts in the pilot's format. Each backup and drill is recorded for
the readiness page in administration. **A backup holds learner records and every secret**: keep it
on private, encrypted storage, never in a repository. Run `backup` daily (for example from cron:
`0 3 * * * cd /path/to/course-core && deploy/docker/core.sh backup`) and `restore-drill` weekly.
To replace the live data with a backup: `core.sh restore --backup <dir> --yes`.

Every service restarts after a crash (`restart: unless-stopped`), and the API waits for a healthy
database. A container that is running but hung shows as `unhealthy` in `status`; Docker does not
restart it by itself. What learners see while a provider, Temporal or the database is down is
described in [Degraded modes](../local/README.md#degraded-modes).

## 7. Upgrade

```sh
deploy/docker/core.sh upgrade v0.1.61
```

It checks that the stack is healthy, stops the API and the supervisor, takes a `pre-upgrade`
backup, checks out the tag and builds it (or, with a registry image, pulls it), and starts the new
release. If the new release is not healthy within 15 minutes (`--timeout-seconds`), it rolls back
by itself: it restores the pre-upgrade backup, returns to the previous commit and image and starts
them, and reports `upgrade_rolled_back` with the reason. Migrations only move forward, which is why
rollback restores the backup. Read [RELEASES.md](../../RELEASES.md) first. Keep local changes in
`.env` or a `compose.override.yaml` next to `compose.yaml`: `upgrade` refuses to check out over
edited tracked files. Without Node and Git on the host, upgrade by image (below).

**Prebuilt images.** Releases do not publish images yet. When they do, set
`COURSE_CORE_IMAGE=ghcr.io/roeehrl/course-core:<tag>` in `.env`; `up` then pulls instead of
building, and `upgrade <tag>` pulls that tag. `core.sh upgrade --image <image>` switches to any
image with the same backup and rollback.

## Code grading

Learners' code runs in a separate, locked-down container per submission: the pinned Python image,
no network, a read-only root, every capability dropped, no new privileges, a non-root user and
bounded memory, CPU, processes and files ([`packages/sandbox`](../../packages/sandbox/README.md)).
Starting those containers needs Docker, and the Docker socket is root on the host, so the API never
gets it. Only `sandbox-gate` has the socket. It has no network, a read-only root and no
capabilities, and it lets through only the calls the sandbox makes, for containers configured
exactly as the sandbox configures them: any other image, mount, network, device, privilege or
setting is refused, and so is every other Docker call. The pinned image is pulled once by the gate
when it starts. Run directories live in the `sandbox-work` volume; each container mounts its own
run directory from it, read-only. The [threat model](../../docs/threat-model.md#docker-compose-deployment-and-the-sandbox-gate)
describes what this protects and what it does not.

## Settings

Everything is in `.env`; [`.env.example`](.env.example) lists each setting. Others the API reads
(sign-in options such as `AUTH_LOGIN_CODES` and `SESSION_HOURS`, telemetry `OTEL_*`, a
least-privilege database role with `MIGRATION_DATABASE_URL`) go in a `compose.override.yaml` under
the `api` service; see [Sign-in settings and passwords](../local/README.md#sign-in-settings-and-passwords),
[OpenTelemetry](../local/README.md#opentelemetry-optional) and
[Least-privilege database role](../local/README.md#least-privilege-database-role). If
`172.30.89.0/24` is in use on your host, change `COURSE_SUBNET`, `COURSE_DYNAMIC_RANGE` and
`COURSE_PROXY_ADDRESS` together. `core.sh` accepts `--env-file <file>` and `--project <name>` to
run a second, separate stack on the same machine (with its own ports).

## How this is tested

- `deploy/docker/compose.test.mjs` and `sandbox-gate.test.mjs` (`npm run test:lifecycle`) check the
  files: pinned images, only the proxy publishes ports, only the gate holds the Docker socket, the
  gate's refusals (bind mounts, other volumes, privileged mode, host namespaces, networks, devices,
  case-variant JSON keys and more), and the operations script's env handling.
- `deploy/docker/smoke.test.mjs` (`npm run test:self-host`, in the required `Sandbox / real Docker
  Linux` CI check) builds the image and runs the stack under a throwaway project with `ops.mjs`:
  it starts with supervision and a teaching verifier that must qualify, creates the owner, checks
  HTTPS, sign-in and the plain loopback listener, runs the dispatcher against the API, imports the
  public algorithms lab's code episode and grades one correct and one wrong program in sandbox
  containers, runs the sandbox's own real-Docker qualification suites through the gate, kills the
  API process and checks it comes back with its data, takes a backup and runs a restore drill,
  upgrades to another image and then to a broken one, which must roll back with the data intact.
  It removes everything it created, also on failure.

Not covered: a real public certificate, `tailscale serve` itself, an upgrade between two real
releases (CI upgrades between two images of the same commit), real provider calls and long-running
operation on your machine.
