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

Container creation precedes execution so cancellation can delete a known container.
Cleanup must be confirmed before the lock is released. Uncertain creation or failed
cleanup leaves the lock and blocks new work; an operator must inspect the named
owned container and reconcile it before removing that lock. Never remove another
service's containers. The broker never pulls an image during a learner request.

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

Registry image metadata came from the official
[Python image](https://hub.docker.com/_/python) on 2026-10-12. A digest pins bytes;
the execution tests establish the tested behavior. Requalify changed images.
