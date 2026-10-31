// Where the real Docker qualification suites keep broker storage, and how their brokers mount it.
// By default: a host directory under the package's ignored .local/, bind-mounted read-only into
// each sandbox. With COURSE_SANDBOX_WORK_VOLUME and COURSE_SANDBOX_WORK_MOUNT (a Compose stack whose
// API reaches Docker only through the sandbox gate): a directory inside that named volume, mounted
// at that path here and into each sandbox as the run's read-only volume subpath. The suites are the
// same in both modes; only storage and the mount differ.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerSandbox as BaseSandbox } from '../dist/index.js';

const name = process.env.COURSE_SANDBOX_WORK_VOLUME, mountPoint = process.env.COURSE_SANDBOX_WORK_MOUNT;
if (Boolean(name) !== Boolean(mountPoint)) throw new Error('Set COURSE_SANDBOX_WORK_VOLUME and COURSE_SANDBOX_WORK_MOUNT together.');
export const workVolume = name ? { name, mountPoint } : undefined;
/** The parent directory of every suite's broker storage. */
export async function localRoot() {
  const root = workVolume ? path.join(workVolume.mountPoint, 'qualification') : fileURLToPath(new URL('../.local/', import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}
/** The broker under test, mounting run directories the way this environment requires. */
export class DockerSandbox extends BaseSandbox {
  constructor(options) { super({ ...options, ...(workVolume ? { workVolume } : {}) }); }
}
/** True when an inspected container's /work mount is this suite's run directory under `directory`. */
export function mountsWorkFrom(object, directory) {
  if (!workVolume) return object.Mounts.some(mount => mount.Destination === '/work' && mount.Source.startsWith(directory + path.sep));
  return (object.HostConfig.Mounts ?? []).some(mount => mount.Target === '/work' && mount.Type === 'volume' && mount.Source === workVolume.name
    && typeof mount.VolumeOptions?.Subpath === 'string' && path.join(workVolume.mountPoint, mount.VolumeOptions.Subpath).startsWith(directory + path.sep));
}
