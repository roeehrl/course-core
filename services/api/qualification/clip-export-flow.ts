import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clipToolchainFromEnvironment, composeClips, exportSceneClip } from '../src/clip-export.js';
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
  console.log(JSON.stringify({ mp4: { bytes: mp4.byteLength, ...mp4Probe }, webm: { bytes: webm.byteLength, ...webmProbe },
    composed: { bytes: composed.byteLength, ...composedProbe }, deterministic: true, elapsedMs: Math.round(performance.now() - started) }));
} finally { rmSync(directory, { recursive: true, force: true }); }
