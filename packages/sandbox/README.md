# Practical exercise execution boundary

This server-only broker runs a learner's Python `solve(input)` function inside a
prepared, digest-pinned Docker image. The application and trusted reference grader
stay outside the container. Only source code, the runner and test **inputs** enter
the container; expected outputs are never mounted. Learner stdout cannot grant a pass.

The current runtime supports standard-library Python. Other language/image adapters
are future integrations, not implied by the SDK's language string. Docker isolation
is not a proof against kernel vulnerabilities; deployments serving mutually
untrusted public users should run this broker in a dedicated isolated host or
stronger microVM/gVisor boundary. Do not mount the Docker socket into learner code.

Every execution uses a non-root UID, read-only root and bind mount, no network,
dropped capabilities, no privilege escalation, a 128MiB default memory/swap ceiling,
half a CPU, 32-process ceiling, 16MiB temporary filesystem, finite wall time and
bounded combined output. No provider/host environment is passed into the container.
No GPUs or acceleration devices are supplied. One container runs per broker storage
directory, enforced by an exclusive filesystem lock even across broker instances.
The in-process admission slot and shared filesystem lock are reserved before
asynchronous Docker readiness checks, so concurrent submissions cannot fan out
preflight subprocesses before admission is counted. Source and reference cases are
copied before asynchronous work; a caller cannot change a running grade's oracle
or source while retaining its original source digest.

A trusted caller may pass `batchCaseCounts` covering every case exactly once, with
at most eight nonempty batches. Batches run serially with the same captured source,
reference data and shared admission lock. There is one deadline and one combined
stdout/stderr budget for the entire submission; neither resets at a batch boundary.
Every batch must finish and every case must match for a pass. Earlier successes
cannot become partial mastery if a later batch fails, times out or is cancelled.
Cleanup must be confirmed before the next container is created. Uncertain creation
or cleanup in any batch preserves the shared quarantine lock. Reports expose actual
output bytes and completed batch counts without disclosing hidden outputs.

Container creation precedes execution so cancellation can delete a known container.
Cleanup must be confirmed before the lock is released. Uncertain creation or failed
cleanup leaves the lock and blocks new work; an operator must inspect the named
owned container and reconcile it before removing that lock. Never remove another
service's containers. The broker never pulls an image during a learner request.
Any dispatched create without a successful, valid container-ID acknowledgement is
uncertain, including nonzero exits and malformed stdout. A subsequent "not found"
response cannot rule out a late creation and therefore cannot release that lock.
Known containers are started and removed by immutable ID. Removal requires an
exact acknowledgement or a complete recognized absence response; a substring in
mixed/error output is not confirmation. Cleanup output is bounded. Filesystem
cleanup failures also quarantine the broker. `readiness()` reports an existing
broker lock as not ready, including when a new process encounters a retained lock.
Locks are never expired or automatically deleted based on age or process IDs.

```sh
npm ci --ignore-scripts
npm test
# Pull the platform-specific image listed in QUALIFIED_IMAGES before qualification.
npm run test:docker
```

`test:docker` fails if Docker or the image is unavailable. It exercises actual
computation, wrong results and fake pass output, filesystem/environment/network
separation, CPU timeout, output flooding, memory allocation, cancellation and
cross-instance admission. Private course fixtures, practical learning validity,
API/evidence integration and production sandbox qualification are separate gates.

The hardening suite additionally uses trusted transport-fault drivers around real
Docker (without executing learner source on the host). It reproduces malformed
and failed creation acknowledgements and misleading cleanup errors, then verifies
that neither the same broker nor another broker sharing storage creates new work.
Its teardown removes only container IDs returned by its own creates, after checking
the sandbox label and test-owned mount path. Tests also inspect actual guest UID,
capabilities, seccomp, no-new-privileges, memory/swap/CPU/PID controls; attempt a
bounded fork overflow and privilege/file-limit escalation; verify that only source
and runner files are mounted and that stdin contains no expected outputs; and try
to forge grades by monkey-patching the Python output serializer. The trusted host
grader rejects those fabricated pass claims.

On 2026-10-12 the 4 unit tests and 13 real Docker tests passed on the local Linux
arm64 Docker runtime with the pinned arm64 image. This does not qualify the x64
image or prove resistance to untested kernel/runtime vulnerabilities. Resource
semantics were checked against Docker's official
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
documentation; live guest observations, rather than flag presence alone, are the
qualification evidence.

Registry image metadata came from the official
[Python image](https://hub.docker.com/_/python) on 2026-10-12. A digest pins bytes;
the execution tests establish the tested behavior. Requalify changed images.
