import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fromVisualExperience, renderSvg, VisualRuntime } from '@course-core/visuals/headless';
import type { CourseManifest } from '@course-core/sdk';
import { checkVisual } from './visual-check.js';

/**
 * Exact technical clips from verified visual scenes, and composition of reviewed clips.
 *
 * A clip is rendered, never generated: the scene runs through the same headless runtime and
 * publish-time check as the learner's renderer, each frame is serialized to SVG at an exact
 * time, rasterized by an `rsvg-convert`-compatible command and encoded by `ffmpeg`. Both tools
 * are external programs named by absolute path (CLIP_RASTERIZER_PATH, CLIP_FFMPEG_PATH); they run
 * without a shell, with argv only, a time limit, a bounded output and a private temporary
 * directory that is always removed. One export or composition runs at a time per process.
 */
export interface ClipToolchain { rasterizerPath: string; ffmpegPath: string }
export const CLIP_LIMITS = Object.freeze({
  maxDurationMs: 20_000, maxFps: 30, minFps: 1, maxWidth: 1280, minWidth: 64, maxFrames: 600,
  maxOutputBytes: 32 * 1024 * 1024, maxFrameBytes: 8 * 1024 * 1024, maxClipsToCompose: 8, processTimeoutMs: 120_000,
});
export type ClipErrorCode = 'CLIP_TOOLCHAIN_UNAVAILABLE' | 'CLIP_SCENE_INVALID' | 'CLIP_RANGE_INVALID' | 'CLIP_TOO_LARGE'
  | 'CLIP_ENCODER_FAILED' | 'CLIP_TIMEOUT' | 'CLIP_BUSY';
export class ClipError extends Error {
  constructor(readonly code: ClipErrorCode) { super(code); }
}
export interface SceneClipRequest { visualId: string; fromMs: number; toMs: number; fps: number; width: number; format: 'mp4' | 'webm'; reducedMotion?: boolean }
export interface EncodedClip { bytes: Uint8Array; mimeType: 'video/mp4' | 'video/webm'; byteLength: number }
type Visual = CourseManifest['visuals'][number];

/** Absolute paths only, so a relative name can never resolve through the working directory. */
export function clipToolchainFromEnvironment(env: NodeJS.ProcessEnv): ClipToolchain | null {
  const rasterizerPath = env.CLIP_RASTERIZER_PATH, ffmpegPath = env.CLIP_FFMPEG_PATH;
  if (!rasterizerPath || !ffmpegPath) return null;
  if (!path.isAbsolute(rasterizerPath) || !path.isAbsolute(ffmpegPath)) throw new Error('CLIP_RASTERIZER_PATH and CLIP_FFMPEG_PATH must be absolute paths.');
  return { rasterizerPath, ffmpegPath };
}

let busy = false;
async function exclusive<T>(body: () => Promise<T>): Promise<T> {
  if (busy) throw new ClipError('CLIP_BUSY');
  busy = true;
  try { return await body(); } finally { busy = false; }
}
/** Container magic: MP4 `ftyp` box or the WebM EBML header. */
function container(bytes: Uint8Array): 'video/mp4' | 'video/webm' | null {
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return null;
}
const MIME = { mp4: 'video/mp4', webm: 'video/webm' } as const;

interface RunOptions { input?: AsyncIterable<Uint8Array> | Uint8Array; maxOutput: number; timeoutMs: number; signal?: AbortSignal | undefined }
/** Runs one program without a shell. Output beyond `maxOutput` kills it; so do the time limit and the signal. */
function run(command: string, args: string[], options: RunOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let settled = false, size = 0, failure: ClipError | null = null;
    const chunks: Buffer[] = [];
    // Only PATH is passed on: provider keys and other secrets in the environment never reach a tool.
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    const stop = (error: ClipError) => { if (!failure) failure = error; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new ClipError('CLIP_TIMEOUT')), options.timeoutMs);
    const abort = () => stop(new ClipError('CLIP_TIMEOUT'));
    options.signal?.addEventListener('abort', abort, { once: true });
    const finish = (error: Error | null, value?: Uint8Array) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' || error.code === 'EACCES' ? new ClipError('CLIP_TOOLCHAIN_UNAVAILABLE') : new ClipError('CLIP_ENCODER_FAILED')));
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutput) stop(new ClipError('CLIP_TOO_LARGE')); else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (failure) return finish(failure);
      if (code !== 0) return finish(new ClipError('CLIP_ENCODER_FAILED'));
      finish(null, new Uint8Array(Buffer.concat(chunks)));
    });
    // A child that exits early closes its stdin; later writes fail and are reported by `close`.
    child.stdin.on('error', () => undefined);
    void (async () => {
      try {
        if (options.input instanceof Uint8Array) child.stdin.write(options.input);
        else if (options.input) for await (const chunk of options.input) {
          if (settled || failure) break;
          if (!child.stdin.write(chunk)) await new Promise<void>((done) => { child.stdin.once('drain', done); child.once('close', () => done()); });
        }
      } catch (error) { stop(error instanceof ClipError ? error : new ClipError('CLIP_ENCODER_FAILED')); }
      finally { child.stdin.end(); }
    })();
  });
}
function codecArgs(format: 'mp4' | 'webm') {
  // Bit-exact flags keep the container free of version strings and timestamps of the encoding run.
  return format === 'mp4'
    ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-f', 'mp4']
    : ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '32', '-row-mt', '0', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-f', 'webm'];
}
function encoded(bytes: Uint8Array, format: 'mp4' | 'webm'): EncodedClip {
  if (container(bytes) !== MIME[format]) throw new ClipError('CLIP_ENCODER_FAILED');
  return { bytes, mimeType: MIME[format], byteLength: bytes.byteLength };
}
/** A private temporary directory, always removed. File errors become encoder failures. */
async function inDirectory<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'course-clip-'));
  try { return await body(directory); }
  catch (error) { throw error instanceof ClipError ? error : new ClipError('CLIP_ENCODER_FAILED'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function readBounded(file: string) {
  const info = await stat(file);
  if (info.size > CLIP_LIMITS.maxOutputBytes) throw new ClipError('CLIP_TOO_LARGE');
  return new Uint8Array(await readFile(file));
}
const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));

/** Validates a request against the scene and the limits. Returns the exact frame times. */
export function clipFrameTimes(durationMs: number, request: Pick<SceneClipRequest, 'fromMs' | 'toMs' | 'fps' | 'width'>) {
  const { fromMs, toMs, fps, width } = request;
  const ok = [fromMs, toMs, fps, width].every(Number.isSafeInteger) && fromMs >= 0 && toMs > fromMs && toMs <= durationMs
    && toMs - fromMs <= CLIP_LIMITS.maxDurationMs && fps >= CLIP_LIMITS.minFps && fps <= CLIP_LIMITS.maxFps
    && width >= CLIP_LIMITS.minWidth && width <= CLIP_LIMITS.maxWidth;
  if (!ok) throw new ClipError('CLIP_RANGE_INVALID');
  const count = Math.max(1, Math.round((toMs - fromMs) * fps / 1000));
  if (count > CLIP_LIMITS.maxFrames) throw new ClipError('CLIP_RANGE_INVALID');
  return Array.from({ length: count }, (_, i) => fromMs + Math.round(i * 1000 / fps));
}

/** Renders `visual` (which must pass the renderer's publish-time check) between two times into an exact clip. */
export async function exportSceneClip(visual: Visual, request: SceneClipRequest, toolchain: ClipToolchain, options: { signal?: AbortSignal } = {}) {
  let scene: ReturnType<typeof fromVisualExperience>;
  try { checkVisual(visual); scene = fromVisualExperience(visual); }
  catch { throw new ClipError('CLIP_SCENE_INVALID'); }
  if (visual.id !== request.visualId) throw new ClipError('CLIP_SCENE_INVALID');
  const times = clipFrameTimes(scene.timeline.durationMs, request);
  const runtime = new VisualRuntime(scene, { viewportWidth: request.width, reducedMotion: request.reducedMotion === true });
  const first = runtime.seek(times[0]!);
  const width = even(request.width), height = even(request.width * first.height / first.width);
  const frameHash = createHash('sha256');
  const markup = (timeMs: number) => {
    const svg = renderSvg(runtime.seek(timeMs), { idPrefix: 'clip', title: scene.title, xmlns: true });
    frameHash.update(svg).update('\n');
    return svg;
  };
  return exclusive(async () => {
    async function* frames() {
      for (const timeMs of times) {
        options.signal?.throwIfAborted();
        yield await run(toolchain.rasterizerPath, ['-w', String(width), '-h', String(height), '-f', 'png'],
          { input: Buffer.from(markup(timeMs)), maxOutput: CLIP_LIMITS.maxFrameBytes, timeoutMs: 30_000, signal: options.signal });
      }
    }
    // MP4 with `+faststart` needs a seekable output, so ffmpeg writes a file in a private directory.
    const bytes = await inDirectory(async (directory) => {
      const target = path.join(directory, `clip.${request.format}`);
      await run(toolchain.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'image2pipe', '-c:v', 'png', '-framerate', String(request.fps),
        '-i', 'pipe:0', '-an', '-vf', `scale=${width}:${height}:flags=bicubic,format=yuv420p`, '-r', String(request.fps), ...codecArgs(request.format), '-fs', String(CLIP_LIMITS.maxOutputBytes + 1), target],
      { input: frames(), maxOutput: 0, timeoutMs: CLIP_LIMITS.processTimeoutMs, signal: options.signal });
      return readBounded(target);
    });
    return { ...encoded(bytes, request.format), frames: times.length, width, height, frameDigest: frameHash.digest('hex') };
  });
}

/** Joins reviewed clips in order into one clip of a uniform size and frame rate. */
export async function composeClips(clips: { bytes: Uint8Array; mimeType: string }[], output: { format: 'mp4' | 'webm'; width: number; height: number; fps: number },
  toolchain: ClipToolchain, options: { signal?: AbortSignal } = {}): Promise<EncodedClip> {
  const total = clips.reduce((sum, clip) => sum + clip.bytes.byteLength, 0);
  if (clips.length < 1 || clips.length > CLIP_LIMITS.maxClipsToCompose || total > CLIP_LIMITS.maxOutputBytes * 2) throw new ClipError('CLIP_RANGE_INVALID');
  if (clips.some((clip) => container(clip.bytes) === null || container(clip.bytes) !== clip.mimeType)) throw new ClipError('CLIP_SCENE_INVALID');
  const { width, height, fps } = output;
  if (![width, height, fps].every(Number.isSafeInteger) || width < CLIP_LIMITS.minWidth || width > CLIP_LIMITS.maxWidth
    || height < CLIP_LIMITS.minWidth || height > CLIP_LIMITS.maxWidth || fps < CLIP_LIMITS.minFps || fps > CLIP_LIMITS.maxFps) throw new ClipError('CLIP_RANGE_INVALID');
  return exclusive(() => inDirectory(async (directory) => {
    const inputs: string[] = [];
    for (const [index, clip] of clips.entries()) {
      const file = path.join(directory, `part-${index}.${clip.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`);
      await writeFile(file, clip.bytes, { mode: 0o600 });
      inputs.push('-i', file);
    }
    const w = even(width), h = even(height);
    const scaled = clips.map((_, i) => `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
    const filter = `${scaled.join(';')};${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[out]`;
    const target = path.join(directory, `composed.${output.format}`);
    await run(toolchain.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs, '-filter_complex', filter, '-map', '[out]', '-an',
      ...codecArgs(output.format), '-fs', String(CLIP_LIMITS.maxOutputBytes + 1), target], { maxOutput: 0, timeoutMs: CLIP_LIMITS.processTimeoutMs, signal: options.signal });
    return encoded(await readBounded(target), output.format);
  }));
}
