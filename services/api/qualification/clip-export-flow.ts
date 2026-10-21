import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipToolchainFromEnvironment, composeClips, exportSceneClip } from '../src/clip-export.js';
import { inspectMedia } from '../src/media-pixels.js';
import { largeVisual } from '../test/large-course-fixture.js';

/**
 * Qualification of exact clip export and composition with the real external tools. Not part of
 * `npm test`, whose unit tests use stand-in programs. It fails, never skips, without the tools:
 *
 *   CLIP_RASTERIZER_PATH=/path/to/rsvg-convert CLIP_FFMPEG_PATH=/path/to/ffmpeg \
 *   [CLIP_FFPROBE_PATH=/path/to/ffprobe] npm run test:clip-export
 *
 * It renders a public synthetic scene into an MP4 and a WebM, checks each with ffprobe (codec,
 * size, frame count, duration), checks that a second export is byte-identical, and composes both.
 * It also runs the frame and pixel inspection of generated media (media-pixels.ts) on the real
 * clips: the rendered scene passes, and a blank clip and a clip of the wrong length are reported.
 */
const toolchain = clipToolchainFromEnvironment(process.env);
if (!toolchain) throw new Error('Set CLIP_RASTERIZER_PATH and CLIP_FFMPEG_PATH to qualify clip export.');
const ffprobe = process.env.CLIP_FFPROBE_PATH ?? path.join(path.dirname(toolchain.ffmpegPath), 'ffprobe');
const visual = largeVisual(1);
const directory = mkdtempSync(path.join(tmpdir(), 'clip-qualification-'));
function probe(bytes: Uint8Array, name: string) {
  const file = path.join(directory, name);
  writeFileSync(file, bytes);
  const result = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'ffprobe could not read the clip');
  const parsed = JSON.parse(result.stdout) as { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[]; format: { duration: string } };
  return { ...parsed.streams[0]!, frames: Number(parsed.streams[0]!.nb_read_frames), duration: Number(parsed.format.duration) };
}
try {
  const started = performance.now();
  const mp4 = await exportSceneClip(visual, { visualId: visual.id, fromMs: 0, toMs: 2000, fps: 12, width: 480, format: 'mp4' }, toolchain);
  const mp4Probe = probe(mp4.bytes, 'scene.mp4');
  assert.deepEqual({ codec: mp4Probe.codec_name, width: mp4Probe.width, height: mp4Probe.height, frames: mp4Probe.frames }, { codec: 'h264', width: mp4.width, height: mp4.height, frames: 24 });
  assert.ok(Math.abs(mp4Probe.duration - 2) < 0.15, `mp4 duration ${mp4Probe.duration}`);
  const again = await exportSceneClip(visual, { visualId: visual.id, fromMs: 0, toMs: 2000, fps: 12, width: 480, format: 'mp4' }, toolchain);
  assert.equal(again.frameDigest, mp4.frameDigest);
  assert.ok(Buffer.from(again.bytes).equals(Buffer.from(mp4.bytes)), 'the same scene and range must encode to the same bytes');
  const webm = await exportSceneClip(visual, { visualId: visual.id, fromMs: 500, toMs: 1500, fps: 10, width: 320, format: 'webm', reducedMotion: true }, toolchain);
  const webmProbe = probe(webm.bytes, 'scene.webm');
  assert.deepEqual({ codec: webmProbe.codec_name, width: webmProbe.width, frames: webmProbe.frames }, { codec: 'vp9', width: 320, frames: 10 });
  const composed = await composeClips([mp4, webm], { format: 'mp4', width: 480, height: mp4.height, fps: 12 }, toolchain);
  const composedProbe = probe(composed.bytes, 'composed.mp4');
  assert.equal(composedProbe.codec_name, 'h264');
  assert.ok(Math.abs(composedProbe.duration - 3) < 0.25, `composed duration ${composedProbe.duration}`);
  // Frame and pixel inspection with the real tools.
  const inspection = { ffmpegPath: toolchain.ffmpegPath, ffprobePath: ffprobe };
  const rendered = await inspectMedia(mp4.bytes, 'video/mp4', { kind: 'video', durationSeconds: 2 }, inspection);
  assert.equal(rendered.verdict, 'consistent', JSON.stringify(rendered.findings));
  const wrongLength = await inspectMedia(mp4.bytes, 'video/mp4', { kind: 'video', durationSeconds: 8 }, inspection);
  assert.deepEqual(wrongLength.findings.map((f) => f.code), ['MEDIA_DURATION_MISMATCH']);
  const blankFile = path.join(directory, 'blank.mp4');
  const made = spawnSync(toolchain.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=12', '-pix_fmt', 'yuv420p', blankFile]);
  assert.equal(made.status, 0, 'ffmpeg could not make the blank clip');
  const blank = await inspectMedia(new Uint8Array(readFileSync(blankFile)), 'video/mp4', { kind: 'video', durationSeconds: 2, aspectRatio: '16:9' }, inspection);
  assert.deepEqual([blank.verdict, blank.findings.map((f) => f.code)], ['contradicted', ['MEDIA_BLANK_FRAMES']]);
  console.log(JSON.stringify({ inspection: { rendered: rendered.verdict, wrongLength: wrongLength.verdict, blank: blank.verdict } }));
  console.log(JSON.stringify({ mp4: { bytes: mp4.byteLength, ...mp4Probe }, webm: { bytes: webm.byteLength, ...webmProbe },
    composed: { bytes: composed.byteLength, ...composedProbe }, deterministic: true, elapsedMs: Math.round(performance.now() - started) }));
} finally { rmSync(directory, { recursive: true, force: true }); }
