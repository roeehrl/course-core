import assert from "node:assert/strict";
import test from "node:test";
import { validateCourse, type CourseManifest } from "@course-core/sdk";
import { compileCourse } from "@course-core/sdk/compiler";
import { sortingDemo } from "../src/demos.js";
import {
  fromVisualExperience,
  RENDERER_ID,
  toVisualExperience,
} from "../src/sdk.js";

test("a real course containing a generated visual validates and compiles through the released SDK", () => {
  const visual = toVisualExperience(sortingDemo);
  const course: CourseManifest = {
    schemaVersion: 1,
    id: "ordering-visual",
    version: "0.1.0",
    title: "Ordering",
    summary: "Public visual integration fixture.",
    locale: "en",
    platforms: ["web"],
    objectives: [
      {
        id: "ordering",
        description: "Read a sequence of exchanges.",
        prerequisites: [],
      },
    ],
    chapters: [
      {
        id: "start",
        title: "Exchanges",
        episodes: [
          {
            id: "first",
            title: "A sequence",
            objectiveIds: ["ordering"],
            blocks: [{ id: "diagram", type: "visual", visualId: visual.id }],
          },
        ],
      },
    ],
    assessments: [],
    gates: [],
    media: [],
    sources: [],
    visuals: [visual],
    extensions: [
      {
        id: RENDERER_ID,
        version: "0.1.0",
        execution: "declarative",
        entrypoint: "renderers/svg.js",
        platforms: ["web"],
        integrity: `sha256-${"a".repeat(64)}`,
        capabilities: ["visual.render"],
        accessibility: {
          keyboard: true,
          reducedMotion: true,
          textAlternative: "Read the sequence.",
        },
      },
    ],
    policy: {
      mode: "bounded",
      work: { additionalEpisodes: 0 },
      existingMaterialAccess: "read_only",
    },
  };
  const result = validateCourse(course);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(
    fromVisualExperience(compileCourse(course).learner.visuals[0]!),
    sortingDemo,
  );
  assert.match(visual.timeline.cues[0]!.event, /^cue-\d+$/);
  const broken = structuredClone(course);
  broken.visuals[0]!.timeline.cues[0]!.event =
    "A human sentence is not an event identifier.";
  assert.equal(validateCourse(broken).valid, false);
});

test("serialized authored scenes do not bake platform libm rounding into their identity", async () => {
  const baselineModule = await import("../src/demos.js");
  const baseline = toVisualExperience(baselineModule.motionDemo);
  const originalSin = Math.sin;
  try {
    Math.sin = (value) => originalSin(value) + Number.EPSILON;
    const alternateUrl = new URL("../src/demos.ts", import.meta.url);
    alternateUrl.search = "libm-serialization-regression=1";
    const alternate = await import(alternateUrl.href);
    assert.deepEqual(toVisualExperience(alternate.motionDemo), baseline);
  } finally {
    Math.sin = originalSin;
  }
});
