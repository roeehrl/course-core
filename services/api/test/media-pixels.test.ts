import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeMedia, expectationsOf, frameDifference, frameStatistics, GRID_HEIGHT, GRID_WIDTH, inspectMedia, mediaInspectionFromEnvironment, parseProbe,
  splitFrames } from "../src/media-pixels.js";

// The analysis is pure and tested on synthetic grey frames. inspectMedia runs stand-in programs
// for ffprobe and ffmpeg that check their arguments and print fixed output; the real tools are
// qualified by qualification/clip-export-flow.ts, which inspects real encoded clips.
const GRID = GRID_WIDTH * GRID_HEIGHT;
/** A frame with a diagonal gradient shifted by `offset` (moves when offset changes). */
const gradient = (offset: number) => Uint8Array.from({ length: GRID }, (_, i) => ((i % GRID_WIDTH) * 6 + Math.floor(i / GRID_WIDTH) * 4 + offset) % 256);
const flat = (value: number) => new Uint8Array(GRID).fill(value);
const moving = (n: number) => Array.from({ length: n }, (_, i) => gradient(i * 3));
const probe = { width: 1280, height: 720, durationSeconds: 4 };
const video = { kind: "video" as const, durationSeconds: 4, aspectRatio: "16:9", resolution: "720p" };
const codes = (result: { findings: { code: string }[] }) => result.findings.map((f) => f.code);

describe("frame and pixel analysis of generated media", () => {
  it("finds nothing wrong with a moving clip of the requested length, aspect and resolution", () => {
    expect(analyzeMedia(video, probe, { frames: moving(8) })).toEqual({ verifier: "pixels", verdict: "consistent", findings: [] });
    expect(frameStatistics(flat(9))).toEqual({ mean: 9, deviation: 0, range: 0 });
    // A sparse diagram (thin strokes on white, averaged down) is not blank.
    const sparse = flat(255).map((v, i) => (i % 40 === 0 ? 240 : v));
    expect(analyzeMedia({ kind: "image" }, { width: 640, height: 360, durationSeconds: null }, { frames: [sparse] }).verdict).toBe("consistent");
    expect(frameStatistics(gradient(0)).deviation).toBeGreaterThan(20);
    expect(frameDifference(gradient(0), gradient(0))).toBe(0);
  });
  it("reports a clip that is too short, the wrong shape, the wrong resolution, mostly blank or still", () => {
    const short = analyzeMedia(video, { ...probe, durationSeconds: 2.4 }, { frames: moving(5) });
    expect(short.verdict).toBe("contradicted");
    expect(short.findings).toEqual([{ code: "MEDIA_DURATION_MISMATCH", source: "media", subject: "duration", expected: "4", found: "2.4" }]);
    // Within 0.5 s, or within 20% of a long clip, is the requested length.
    expect(analyzeMedia(video, { ...probe, durationSeconds: 4.4 }, { frames: moving(8) }).verdict).toBe("consistent");
    expect(codes(analyzeMedia(video, { ...probe, width: 720, height: 1280 }, { frames: moving(8) }))).toEqual(["MEDIA_ASPECT_MISMATCH"]);
    expect(codes(analyzeMedia(video, { ...probe, width: 1920, height: 1080 }, { frames: moving(8) }))).toEqual(["MEDIA_RESOLUTION_MISMATCH"]);
    const blank = analyzeMedia(video, probe, { frames: [flat(0), flat(0), flat(1).map((v, i) => v + (i % 3)), flat(0), gradient(0), gradient(3)] });
    expect(blank).toMatchObject({ verdict: "contradicted", findings: [{ code: "MEDIA_BLANK_FRAMES", expected: "6", found: "4" }] });
    // A still picture presented as a video never moves: reported for the reviewer, not blocking.
    expect(analyzeMedia(video, probe, { frames: [gradient(5), gradient(5), gradient(5), gradient(5)] })).toMatchObject({ verdict: "consistent",
      findings: [{ code: "MEDIA_NO_MOTION", found: "0" }] });
  });
  it("reports fewer visible cuts than storyboard shots without blocking, and a still image as an image", () => {
    const composed = analyzeMedia({ kind: "video", shots: 3 }, probe, { frames: moving(8) });
    expect(composed).toMatchObject({ verdict: "consistent", findings: [{ code: "MEDIA_FEWER_CUTS_THAN_SHOTS", expected: "3", found: "1" }] });
    // Two hard cuts between very different pictures count as three shots.
    const cut = [gradient(0), gradient(2), flat(250).map((v, i) => (i % 2 ? v : 10)), flat(250).map((v, i) => (i % 2 ? v : 12)), gradient(128), gradient(130)];
    expect(analyzeMedia({ kind: "video", shots: 3 }, probe, { frames: cut }).findings).toEqual([]);
    const image = { kind: "image" as const, aspectRatio: "1:1" };
    expect(analyzeMedia(image, { width: 1024, height: 1024, durationSeconds: null }, { frames: [gradient(0)] }).verdict).toBe("consistent");
    expect(analyzeMedia(image, { width: 1024, height: 1024, durationSeconds: null }, { frames: [flat(255)] })).toMatchObject({ verdict: "contradicted",
      findings: [{ code: "MEDIA_BLANK_FRAMES" }] });
    expect(codes(analyzeMedia(image, { width: 1600, height: 900, durationSeconds: null }, { frames: [gradient(0)] }))).toEqual(["MEDIA_ASPECT_MISMATCH"]);
  });
  it("cannot verify media it could not read", () => {
    for (const [p, frames] of [[null, moving(3)], [probe, []], [{ ...probe, width: 0 }, moving(3)]] as const)
      expect(analyzeMedia(video, p, { frames: [...frames] })).toMatchObject({ verdict: "unverified", findings: [{ code: "MEDIA_UNREADABLE" }] });
    expect(analyzeMedia(video, probe, { frames: [new Uint8Array(10)] }).verdict).toBe("unverified");
  });
  it("derives what to expect from each kind of job", () => {
    expect(expectationsOf({ kind: "generated_short_video", settings: { durationSeconds: 8, aspectRatio: "16:9", resolution: "720p" } }, null))
      .toEqual({ kind: "video", durationSeconds: 8, aspectRatio: "16:9", resolution: "720p" });
    expect(expectationsOf({ kind: "generated_image", settings: { aspectRatio: "1:1", imageSize: "1K" } }, null)).toEqual({ kind: "image", aspectRatio: "1:1" });
    expect(expectationsOf({ kind: "scene_clip", settings: { fromMs: 500, toMs: 2500 } }, null)).toEqual({ kind: "video", durationSeconds: 2 });
    expect(expectationsOf({ kind: "composed_video", settings: { width: 640 } }, 4)).toEqual({ kind: "video", shots: 4 });
  });
  it("reads ffprobe output and raw frames defensively", () => {
    expect(parseProbe('{"streams":[{"width":640,"height":360}],"format":{"duration":"3.5"}}')).toEqual({ width: 640, height: 360, durationSeconds: 3.5 });
    expect(parseProbe('{"streams":[{"width":640,"height":360}],"format":{}}')).toEqual({ width: 640, height: 360, durationSeconds: null });
    for (const text of ["", "not json", '{"streams":[]}', '{"streams":[{"width":-1,"height":2}]}']) expect(parseProbe(text)).toBeNull();
    expect(splitFrames(new Uint8Array(GRID * 2 + 7))).toHaveLength(2);
    expect(splitFrames(new Uint8Array(GRID * 100))).toHaveLength(60);
  });
});

const bin = mkdtempSync(path.join(tmpdir(), "media-pixels-tools-"));
const log = path.join(bin, "calls.log");
afterAll(() => rmSync(bin, { recursive: true, force: true }));
function tool(name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const ffprobe = tool("ffprobe", `
if (args.slice(0, 8).join(' ') !== '-v error -select_streams v:0 -show_entries stream=width,height:format=duration -of json') process.exit(3);
fs.appendFileSync(${JSON.stringify(log)}, 'probe ' + fs.statSync(args[8]).size + '\\n');
process.stdout.write(JSON.stringify({ streams: [{ width: 1280, height: 720 }], format: { duration: '4.000' } }));`);
// Writes `n` grey ${GRID_WIDTH}x${GRID_HEIGHT} frames: a gradient that moves, or one flat colour.
const sampler = (mode: "moving" | "flat") => tool("ffmpeg-" + mode, `
const filter = args[args.indexOf('-vf') + 1];
if (!/scale=${GRID_WIDTH}:${GRID_HEIGHT}:flags=area,format=gray$/.test(filter) || args.at(-1) !== 'pipe:1' || args.at(-2) !== 'rawvideo') process.exit(3);
fs.appendFileSync(${JSON.stringify(log)}, 'sample ' + filter + ' ' + args[args.indexOf('-frames:v') + 1] + '\\n');
const frames = filter.startsWith('fps=') ? 8 : 1, out = Buffer.alloc(frames * ${GRID});
for (let f = 0; f < frames; f++) for (let i = 0; i < ${GRID}; i++)
  out[f * ${GRID} + i] = ${JSON.stringify(mode)} === 'flat' ? 0 : ((i % ${GRID_WIDTH}) * 6 + Math.floor(i / ${GRID_WIDTH}) * 4 + f * 3) % 256;
process.stdout.write(out);`);
const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n"); } finally { rmSync(log, { force: true }); } };
const MP4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);

describe("inspecting an asset with the tools", () => {
  it("probes and samples a private copy of the asset, two frames per second for a video and one for an image", async () => {
    expect(await inspectMedia(MP4, "video/mp4", video, { ffmpegPath: sampler("moving"), ffprobePath: ffprobe })).toEqual({ verifier: "pixels", verdict: "consistent", findings: [] });
    expect(calls()).toEqual([`probe ${MP4.byteLength}`, `sample fps=2,scale=${GRID_WIDTH}:${GRID_HEIGHT}:flags=area,format=gray 60`]);
    expect(await inspectMedia(MP4, "image/png", { kind: "image", aspectRatio: "16:9" }, { ffmpegPath: sampler("flat"), ffprobePath: ffprobe }))
      .toMatchObject({ verdict: "contradicted", findings: [{ code: "MEDIA_BLANK_FRAMES" }] });
    expect(calls()).toEqual([`probe ${MP4.byteLength}`, `sample scale=${GRID_WIDTH}:${GRID_HEIGHT}:flags=area,format=gray 1`]);
  });
  it("returns an unverified result, never an exception, when a tool is missing or fails or the type is unknown", async () => {
    expect(await inspectMedia(MP4, "video/mp4", video, { ffmpegPath: path.join(bin, "missing"), ffprobePath: ffprobe }))
      .toMatchObject({ verdict: "unverified", findings: [{ code: "MEDIA_INSPECTION_UNAVAILABLE" }] });
    calls();
    expect(await inspectMedia(MP4, "video/mp4", video, { ffmpegPath: tool("ffmpeg-fail", "process.exit(1);"), ffprobePath: ffprobe }))
      .toMatchObject({ verdict: "unverified", findings: [{ code: "MEDIA_UNREADABLE" }] });
    calls();
    expect(await inspectMedia(MP4, "text/html", video, { ffmpegPath: sampler("moving"), ffprobePath: ffprobe }))
      .toMatchObject({ verdict: "unverified", findings: [{ code: "MEDIA_UNREADABLE" }] });
    // One inspection at a time per process.
    const [first, second] = await Promise.all([inspectMedia(MP4, "video/mp4", video, { ffmpegPath: sampler("moving"), ffprobePath: ffprobe }),
      inspectMedia(MP4, "video/mp4", video, { ffmpegPath: sampler("moving"), ffprobePath: ffprobe })]);
    expect([first.verdict, second.findings[0]?.code]).toEqual(["consistent", "MEDIA_INSPECTION_BUSY"]);
    calls();
  });
  it("uses the clip tool settings, with ffprobe beside ffmpeg unless named, and absolute paths only", () => {
    expect(mediaInspectionFromEnvironment({})).toBeNull();
    expect(mediaInspectionFromEnvironment({ CLIP_FFMPEG_PATH: path.join(bin, "ffmpeg-moving") })).toEqual({ ffmpegPath: path.join(bin, "ffmpeg-moving"), ffprobePath: ffprobe });
    expect(mediaInspectionFromEnvironment({ CLIP_FFMPEG_PATH: "/nowhere/ffmpeg" })).toBeNull();
    expect(mediaInspectionFromEnvironment({ CLIP_FFMPEG_PATH: "/nowhere/ffmpeg", CLIP_FFPROBE_PATH: "/elsewhere/ffprobe" })).toEqual({ ffmpegPath: "/nowhere/ffmpeg",
      ffprobePath: "/elsewhere/ffprobe" });
    expect(() => mediaInspectionFromEnvironment({ CLIP_FFMPEG_PATH: "ffmpeg", CLIP_FFPROBE_PATH: "ffprobe" })).toThrow();
  });
});
