import { describe, expect, it } from "vitest";
import {
  validateCourse,
  type CourseManifest,
  type VisualExperience,
} from "@course-core/sdk";
import { compileCourse } from "@course-core/sdk/compiler";
import {
  fromVisualExperience,
  toVisualExperience,
} from "@course-core/visuals/headless";
import { motionDemo } from "@course-core/visuals/demos";
import fixture from "./visual-fixture.json";

describe("installed public visual and released SDK boundary", () => {
  it("keeps the browser fixture in sync with the installed serializer and compiles a real course", () => {
    const experience = fixture as unknown as VisualExperience;
    expect(experience).toEqual(toVisualExperience(motionDemo));
    expect(
      experience.timeline.cues.every((cue) => /^cue-\d+$/.test(cue.event)),
    ).toBe(true);
    const course: CourseManifest = {
      schemaVersion: 1,
      id: "public-motion",
      version: "1.0.0",
      title: "Motion",
      summary: "Explore a public path.",
      locale: "en",
      platforms: ["web"],
      objectives: [
        {
          id: "observe",
          description: "Describe a changing position.",
          prerequisites: [],
        },
      ],
      chapters: [
        {
          id: "paths",
          title: "Paths",
          episodes: [
            {
              id: "first",
              title: "A path",
              objectiveIds: ["observe"],
              blocks: [
                { id: "diagram", type: "visual", visualId: experience.id },
              ],
            },
          ],
        },
      ],
      visuals: [experience],
      assessments: [],
      gates: [],
      media: [],
      sources: [],
      extensions: [
        {
          id: experience.rendererId,
          version: "0.1.0",
          integrity: `sha256-${"a".repeat(64)}`,
          execution: "declarative",
          entrypoint: "renderers/svg.js",
          platforms: ["web"],
          capabilities: ["visual.render"],
          accessibility: {
            keyboard: true,
            reducedMotion: true,
            textAlternative: experience.accessibility.description,
          },
        },
      ],
      policy: {
        mode: "bounded",
        existingMaterialAccess: "read_only",
        work: { additionalEpisodes: 0 },
      },
    };
    const validation = validateCourse(course);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(
      fromVisualExperience(compileCourse(course).learner.visuals[0]!),
    ).toEqual(motionDemo);
    // Cue prose belongs in the renderer scene, never in SDK event IDs.
    const broken = structuredClone(course);
    broken.visuals[0]!.timeline.cues[0]!.event =
      "A sentence is not an event ID.";
    expect(validateCourse(broken).valid).toBe(false);
  });
});
