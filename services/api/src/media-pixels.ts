import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClipError, inDirectory, run } from './clip-export.js';
import type { CheckFinding, CheckResult } from './media-verifier.js';

/**
 * A frame and pixel inspection of generated media against what its job asked for (O09, O10).
 *
 * The text checks (media-verifier.ts) compare what a reviewer wrote about a clip with its
 * sources; they cannot see the clip. This one looks at the asset: `ffprobe` reads its duration
 * and frame size, and `ffmpeg` samples frames (two per second, at most 60) scaled to a 32x18
 * grey grid. From those numbers it reports what a script or storyboard can be checked against
 * mechanically:
 *
 * - the duration differs from the requested length (more than 0.5 s and 20%);
 * - the frame's aspect ratio or resolution differs from the requested one;
 * - at least half of the sampled frames are blank (one flat colour, within a few grey levels);
 * - a video never visibly moves (reported, not blocking: subtle motion can vanish at this size);
 * - a composed video has fewer visible cuts than its storyboard has shots (reported, not blocking:
 *   a cut between similar shots can be invisible at this size).
 *
 * It checks technical and visual properties only. It cannot tell whether a frame shows the right
 * thing, so it never makes media acceptable; staff still review every asset. The tools are the
 * clip tools (CLIP_FFMPEG_PATH, and CLIP_FFPROBE_PATH or `ffprobe` next to ffmpeg), run without a
 * shell, with bounded output and a time limit, on a private copy of the asset.
 */
export interface MediaInspectionTools { ffmpegPath: string; ffprobePath: string }
export interface MediaExpectations {
  kind: 'video' | 'image';
  durationSeconds?: number | undefined;
  aspectRatio?: string | undefined;
  /** "720p": the shorter side of the frame, in pixels. */
  resolution?: string | undefined;
  /** For a composed video: how many storyboard shots it joins. */
  shots?: number | undefined;
}
export interface MediaProbe { width: number; height: number; durationSeconds: number | null }
/** Sampled frames: each `GRID_WIDTH * GRID_HEIGHT` grey bytes, `SAMPLE_FPS` per second for a video. */
export interface FrameSamples { frames: Uint8Array[] }

export const GRID_WIDTH = 32, GRID_HEIGHT = 18, SAMPLE_FPS = 2, MAX_SAMPLES = 60;
const GRID = GRID_WIDTH * GRID_HEIGHT;
/** A frame whose grey levels span no more than this (0-255) is one flat colour. A sparse diagram
 * (thin strokes on white) still spans far more after scaling, so it is never taken for blank. */
const BLANK_RANGE = 4;
/** Mean absolute difference between consecutive samples below which nothing visibly moved. A
 * diagram whose thin strokes move changes the scaled frames by about 0.1, so this is low. */
const STILL_DIFFERENCE = 0.05;
/** Mean absolute difference above which two consecutive samples are counted as a cut. */
const CUT_DIFFERENCE = 40;
const MAX_FINDINGS = 20;

/** The inspection tools, from the clip tool settings. Absolute paths only; null when not configured. */
export function mediaInspectionFromEnvironment(env: NodeJS.ProcessEnv): MediaInspectionTools | null {
  const ffmpegPath = env.CLIP_FFMPEG_PATH;
  if (!ffmpegPath) return null;
  const ffprobePath = env.CLIP_FFPROBE_PATH ?? path.join(path.dirname(ffmpegPath), 'ffprobe');
  if (!path.isAbsolute(ffmpegPath) || !path.isAbsolute(ffprobePath)) throw new Error('CLIP_FFMPEG_PATH and CLIP_FFPROBE_PATH must be absolute paths.');
  return env.CLIP_FFPROBE_PATH || existsSync(ffprobePath) ? { ffmpegPath, ffprobePath } : null;
}

/** Mean, standard deviation and range of one sampled frame's grey levels. */
export function frameStatistics(frame: Uint8Array) {
  let sum = 0, squares = 0, min = 255, max = 0;
  for (const value of frame) { sum += value; squares += value * value; if (value < min) min = value; if (value > max) max = value; }
  const mean = sum / frame.length;
  return { mean, deviation: Math.sqrt(Math.max(0, squares / frame.length - mean * mean)), range: frame.length ? max - min : 0 };
}
/** Mean absolute difference between two sampled frames (0-255). */
export function frameDifference(a: Uint8Array, b: Uint8Array) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}
const ratio = (value: string | undefined) => {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value ?? '');
  return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
};
const round = (value: number, digits = 2) => String(Math.round(value * 10 ** digits) / 10 ** digits);
const finding = (code: string, subject: string, expected: string | null, found: string): CheckFinding =>
  ({ code: code as CheckFinding['code'], source: 'media', subject, expected, found });
/** Findings that make the media unusable as asked; the others are reported for the reviewer. */
const BLOCKING = new Set(['MEDIA_DURATION_MISMATCH', 'MEDIA_ASPECT_MISMATCH', 'MEDIA_RESOLUTION_MISMATCH', 'MEDIA_BLANK_FRAMES']);

/** The pure part of the inspection: compares measured numbers with the expectations. */
export function analyzeMedia(expected: MediaExpectations, probe: MediaProbe | null, samples: FrameSamples | null): CheckResult {
  const frames = (samples?.frames ?? []).filter((frame) => frame.length === GRID);
  if (!probe || probe.width <= 0 || probe.height <= 0 || !frames.length)
    return { verifier: 'pixels', verdict: 'unverified', findings: [finding('MEDIA_UNREADABLE', 'media', null, 'unreadable')] };
  const findings: CheckFinding[] = [];
  if (expected.kind === 'video' && expected.durationSeconds && probe.durationSeconds !== null) {
    const off = Math.abs(probe.durationSeconds - expected.durationSeconds);
    if (off > 0.5 && off > 0.2 * expected.durationSeconds)
      findings.push(finding('MEDIA_DURATION_MISMATCH', 'duration', String(expected.durationSeconds), round(probe.durationSeconds, 1)));
  }
  const wanted = ratio(expected.aspectRatio), actual = probe.width / probe.height;
  if (wanted && Math.abs(actual - wanted) / wanted > 0.03)
    findings.push(finding('MEDIA_ASPECT_MISMATCH', 'aspect', expected.aspectRatio!, `${probe.width}x${probe.height}`));
  const lines = /^(\d{3,4})p$/.exec(expected.resolution ?? '');
  if (lines && Math.min(probe.width, probe.height) !== Number(lines[1]))
    findings.push(finding('MEDIA_RESOLUTION_MISMATCH', 'resolution', expected.resolution!, `${probe.width}x${probe.height}`));
  const blank = frames.filter((frame) => frameStatistics(frame).range <= BLANK_RANGE).length;
  if (blank * 2 >= frames.length)
    findings.push(finding('MEDIA_BLANK_FRAMES', 'frames', `${frames.length}`, `${blank}`));
  if (expected.kind === 'video' && frames.length >= 3) {
    const differences = frames.slice(1).map((frame, i) => frameDifference(frames[i]!, frame));
    if (Math.max(...differences) < STILL_DIFFERENCE && blank * 2 < frames.length)
      findings.push(finding('MEDIA_NO_MOTION', 'motion', null, round(Math.max(...differences))));
    const cuts = differences.filter((d) => d > CUT_DIFFERENCE).length;
    if (expected.shots && expected.shots > 1 && cuts + 1 < expected.shots)
      findings.push(finding('MEDIA_FEWER_CUTS_THAN_SHOTS', 'shots', String(expected.shots), String(cuts + 1)));
  }
  const contradicted = findings.some((f) => BLOCKING.has(f.code));
  return { verifier: 'pixels', verdict: contradicted ? 'contradicted' : 'consistent', findings: findings.slice(0, MAX_FINDINGS) };
}

/** What the job asked for, from its kind, settings and storyboard. */
export function expectationsOf(job: { kind: string; settings: Record<string, unknown> }, shots: number | null): MediaExpectations {
  const s = job.settings, number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
    text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (job.kind === 'generated_image') return { kind: 'image', aspectRatio: text(s.aspectRatio) };
  if (job.kind === 'scene_clip') {
    const from = number(s.fromMs), to = number(s.toMs);
    return { kind: 'video', durationSeconds: from !== undefined && to !== undefined ? (to - from) / 1000 : undefined };
  }
  if (job.kind === 'composed_video') return { kind: 'video', ...(shots ? { shots } : {}) };
  return { kind: 'video', durationSeconds: number(s.durationSeconds), aspectRatio: text(s.aspectRatio), resolution: text(s.resolution) };
}

let busy = false;
const EXTENSION: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** Runs the tools on a private copy of the asset. One inspection at a time per process; a busy,
 * missing or failing tool gives an `unverified` result with a code, never an exception. */
export async function inspectMedia(bytes: Uint8Array, mimeType: string, expected: MediaExpectations, tools: MediaInspectionTools,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CheckResult> {
  const unverified = (code: string): CheckResult => ({ verifier: 'pixels', verdict: 'unverified', findings: [finding(code, 'media', null, code)] });
  const extension = EXTENSION[mimeType];
  if (!extension) return unverified('MEDIA_UNREADABLE');
  if (busy) return unverified('MEDIA_INSPECTION_BUSY');
  busy = true;
  const timeoutMs = options.timeoutMs ?? 60_000;
  try {
    return await inDirectory(async (directory) => {
      const file = path.join(directory, `asset.${extension}`);
      await writeFile(file, bytes, { mode: 0o600 });
      const probeOut = await run(tools.ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
        { maxOutput: 65_536, timeoutMs, signal: options.signal });
      const probe = parseProbe(new TextDecoder().decode(probeOut));
      const video = expected.kind === 'video';
      const raw = await run(tools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-an',
        '-vf', `${video ? `fps=${SAMPLE_FPS},` : ''}scale=${GRID_WIDTH}:${GRID_HEIGHT}:flags=area,format=gray`, '-frames:v', String(video ? MAX_SAMPLES : 1), '-f', 'rawvideo', 'pipe:1'],
      { maxOutput: GRID * MAX_SAMPLES, timeoutMs, signal: options.signal });
      return analyzeMedia(expected, probe, { frames: splitFrames(raw) });
    });
  } catch (error) {
    return unverified(error instanceof ClipError && error.code === 'CLIP_TOOLCHAIN_UNAVAILABLE' ? 'MEDIA_INSPECTION_UNAVAILABLE' : 'MEDIA_UNREADABLE');
  } finally { busy = false; }
}
/** ffprobe's JSON: the first video stream's size and the container duration. */
export function parseProbe(text: string): MediaProbe | null {
  try {
    const parsed = JSON.parse(text) as { streams?: { width?: unknown; height?: unknown }[]; format?: { duration?: unknown } };
    const stream = parsed.streams?.[0], width = Number(stream?.width), height = Number(stream?.height), duration = Number(parsed.format?.duration);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
    return { width, height, durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null };
  } catch { return null; }
}
export function splitFrames(raw: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset + GRID <= raw.length && frames.length < MAX_SAMPLES; offset += GRID) frames.push(raw.slice(offset, offset + GRID));
  return frames;
}
