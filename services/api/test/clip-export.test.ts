import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CLIP_LIMITS, ClipError, clipFrameTimes, clipToolchainFromEnvironment, composeClips, exportSceneClip, type ClipToolchain } from "../src/clip-export.js";
import { largeVisual } from "./large-course-fixture.js";

// Stand-in programs for the rasterizer and ffmpeg. They check their arguments, record what they
// received and write fixed bytes. The real tools are qualified by qualification/clip-export-flow.ts.
const bin = mkdtempSync(path.join(tmpdir(), "clip-tools-"));
const log = path.join(bin, "calls.log");
function tool(name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const rasterizer = tool("raster", `
if (args.join(' ') !== '-w ' + args[1] + ' -h ' + args[3] + ' -f png') process.exit(3);
const input = fs.readFileSync(0, 'utf8');
if (!input.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')) process.exit(4);
fs.appendFileSync(${JSON.stringify(log)}, 'frame ' + args[1] + 'x' + args[3] + '\\n');
process.stdout.write(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from(input.length.toString())]));`);
const encoderBody = (header: string) => `
const target = args.at(-1);
if (args.includes('-filter_complex')) fs.appendFileSync(${JSON.stringify(log)}, 'compose ' + args.filter(a => a === '-i').length + '\\n');
else { const input = fs.readFileSync(0); let frames = 0; for (let i = 0; i < input.length; i++) if (input[i] === 137 && input[i + 1] === 80) frames++;
  fs.appendFileSync(${JSON.stringify(log)}, 'encode ' + frames + ' ' + args[args.indexOf('-framerate') + 1] + '\\n'); }
${header}`;
const ffmpeg = tool("ffmpeg", encoderBody(`fs.writeFileSync(target, target.endsWith('.mp4') ? Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,1,2,3,4]) : Buffer.from([0x1a,0x45,0xdf,0xa3,1,2]));`));
const failing = tool("ffmpeg-fail", "process.exit(1);");
const garbage = tool("ffmpeg-garbage", encoderBody("fs.writeFileSync(target, 'not a video');"));
const slow = tool("ffmpeg-slow", "setTimeout(() => {}, 60_000);");
const flood = tool("raster-flood", "fs.readFileSync(0); const chunk = Buffer.alloc(1024 * 1024, 1); for (let i = 0; i < 12; i++) process.stdout.write(chunk);");
const fake: ClipToolchain = { rasterizerPath: rasterizer, ffmpegPath: ffmpeg };
const visual = largeVisual(7);
const request = (extra: Partial<Parameters<typeof exportSceneClip>[1]> = {}) =>
  ({ visualId: visual.id, fromMs: 0, toMs: 1000, fps: 5, width: 320, format: "mp4" as const, ...extra });
const calls = () => { try { return readFileSync(log, "utf8").trim().split("\n"); } finally { rmSync(log, { force: true }); } };
const code = (expected: string) => (error: unknown) => error instanceof ClipError && error.code === expected;
afterAll(() => rmSync(bin, { recursive: true, force: true }));
// Each export starts a stand-in process per frame; a loaded CI runner can take seconds for that.
const slowSpawns = { timeout: 30_000 };

describe("exact clips from verified scenes", slowSpawns, () => {
  it("renders one frame per exact time, encodes them once and returns a checked container", async () => {
    rmSync(log, { force: true });
    const clip = await exportSceneClip(visual, request(), fake);
    expect(clip).toMatchObject({ mimeType: "video/mp4", frames: 5, width: 320, height: 160 });
    expect(Buffer.from(clip.bytes).subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(calls()).toEqual([...Array(5).fill("frame 320x160"), "encode 5 5"]);
    const webm = await exportSceneClip(visual, request({ format: "webm", fromMs: 500, toMs: 2000, fps: 2 }), fake);
    expect(webm).toMatchObject({ mimeType: "video/webm", frames: 3 });
    expect(calls().at(-1)).toBe("encode 3 2");
  });

  it("the same scene and range give the same frame digest; another range does not", async () => {
    const a = await exportSceneClip(visual, request(), fake), b = await exportSceneClip(visual, request(), fake);
    const c = await exportSceneClip(visual, request({ fromMs: 200 }), fake);
    expect(a.frameDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(b.frameDigest).toBe(a.frameDigest);
    expect(c.frameDigest).not.toBe(a.frameDigest);
    calls();
  });

  it("exact frame times are bounded by the scene and the limits", () => {
    expect(clipFrameTimes(2000, { fromMs: 0, toMs: 1000, fps: 4, width: 320 })).toEqual([0, 250, 500, 750]);
    for (const bad of [{ toMs: 0 }, { toMs: 2001 }, { fromMs: -1 }, { fps: 0 }, { fps: 31 }, { width: 2000 }, { width: 10 }, { fps: 2.5 }])
      expect(() => clipFrameTimes(2000, { fromMs: 0, toMs: 1000, fps: 4, width: 320, ...bad }), JSON.stringify(bad)).toThrow(ClipError);
    expect(() => clipFrameTimes(60_000, { fromMs: 0, toMs: CLIP_LIMITS.maxDurationMs + 1, fps: 1, width: 320 })).toThrow(ClipError);
  });

  it("refuses a scene that fails the renderer's check, or a different visual id, before running any tool", async () => {
    rmSync(log, { force: true });
    const broken = structuredClone(visual) as unknown as { scene: { nodes: { width: unknown }[] } };
    broken.scene.nodes[0]!.width = { state: "missing" };
    await expect(exportSceneClip(broken as never, request(), fake)).rejects.toSatisfy(code("CLIP_SCENE_INVALID"));
    await expect(exportSceneClip(visual, request({ visualId: "other" }), fake)).rejects.toSatisfy(code("CLIP_SCENE_INVALID"));
    await expect(exportSceneClip(visual, request({ toMs: 999_999 }), fake)).rejects.toSatisfy(code("CLIP_RANGE_INVALID"));
    expect(() => readFileSync(log)).toThrow();
  });

  it("reports a missing tool, a failing encoder, a wrong container, a timeout and an oversized frame", async () => {
    await expect(exportSceneClip(visual, request(), { ...fake, rasterizerPath: path.join(bin, "absent") })).rejects.toSatisfy(code("CLIP_TOOLCHAIN_UNAVAILABLE"));
    await expect(exportSceneClip(visual, request(), { ...fake, ffmpegPath: failing })).rejects.toSatisfy(code("CLIP_ENCODER_FAILED"));
    await expect(exportSceneClip(visual, request(), { ...fake, ffmpegPath: garbage })).rejects.toSatisfy(code("CLIP_ENCODER_FAILED"));
    await expect(exportSceneClip(visual, request(), { ...fake, rasterizerPath: flood })).rejects.toSatisfy(code("CLIP_TOO_LARGE"));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(composeClips([{ bytes: Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]), mimeType: "video/mp4" }],
      { format: "mp4", width: 320, height: 160, fps: 5 }, { ...fake, ffmpegPath: slow }, { signal: controller.signal })).rejects.toSatisfy(code("CLIP_TIMEOUT"));
    calls();
  });

  it("runs one export at a time per process", async () => {
    const first = exportSceneClip(visual, request(), fake);
    await expect(exportSceneClip(visual, request(), fake)).rejects.toSatisfy(code("CLIP_BUSY"));
    await first;
    calls();
  });
});

describe("composition of reviewed clips", slowSpawns, () => {
  const mp4 = { bytes: Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]), mimeType: "video/mp4" };
  const webm = { bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 9]), mimeType: "video/webm" };
  it("joins clips of either container into one in a single encoder run", async () => {
    rmSync(log, { force: true });
    const joined = await composeClips([mp4, webm, mp4], { format: "webm", width: 320, height: 180, fps: 10 }, fake);
    expect(joined.mimeType).toBe("video/webm");
    expect(calls()).toEqual(["compose 3"]);
  });
  it("refuses empty, too many, mislabelled or unknown inputs and invalid sizes", async () => {
    const output = { format: "mp4" as const, width: 320, height: 180, fps: 10 };
    await expect(composeClips([], output, fake)).rejects.toSatisfy(code("CLIP_RANGE_INVALID"));
    await expect(composeClips(Array(CLIP_LIMITS.maxClipsToCompose + 1).fill(mp4), output, fake)).rejects.toSatisfy(code("CLIP_RANGE_INVALID"));
    await expect(composeClips([{ ...mp4, mimeType: "video/webm" }], output, fake)).rejects.toSatisfy(code("CLIP_SCENE_INVALID"));
    await expect(composeClips([{ bytes: Uint8Array.from([1, 2, 3, 4, 5]), mimeType: "video/mp4" }], output, fake)).rejects.toSatisfy(code("CLIP_SCENE_INVALID"));
    await expect(composeClips([mp4], { ...output, width: 4000 }, fake)).rejects.toSatisfy(code("CLIP_RANGE_INVALID"));
  });
});

describe("toolchain configuration", () => {
  it("is absent unless both tools are set, and accepts absolute paths only", () => {
    expect(clipToolchainFromEnvironment({})).toBeNull();
    expect(clipToolchainFromEnvironment({ CLIP_FFMPEG_PATH: "/usr/bin/ffmpeg" })).toBeNull();
    expect(clipToolchainFromEnvironment({ CLIP_FFMPEG_PATH: "/usr/bin/ffmpeg", CLIP_RASTERIZER_PATH: "/usr/bin/rsvg-convert" }))
      .toEqual({ ffmpegPath: "/usr/bin/ffmpeg", rasterizerPath: "/usr/bin/rsvg-convert" });
    expect(() => clipToolchainFromEnvironment({ CLIP_FFMPEG_PATH: "ffmpeg", CLIP_RASTERIZER_PATH: "/usr/bin/rsvg-convert" })).toThrow(/absolute/);
  });
});
