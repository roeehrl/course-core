import type { ServerSnapshot } from "../src/client/apiClient";
import type { VisualExperience } from "@course-core/sdk";
import experience from "./visual-fixture.json";
export function connectedSnapshot(): ServerSnapshot {
  return {
    enrollmentId: "enrollment-1",
    revision: 1,
    courseDigest: "course-digest",
    profile: {
      displayName: "Learner",
      goal: "Understand change",
      pace: "steady",
    },
    status: "active",
    complete: false,
    nextEpisodeId: "intro",
    inaccessibleEpisodeIds: [],
    activeChallenges: [],
    lessons: [
      {
        id: "intro",
        status: "available",
        completedBlockIds: [],
        gate: {
          passed: false,
          objectives: [
            { id: "observe", families: [], required: 2, passed: false },
          ],
        },
      },
    ],
    course: {
      schemaVersion: 1,
      id: "public-study",
      version: "1.0.0",
      title: "Everyday patterns",
      summary: "Observe and compare.",
      locale: "en",
      platforms: ["web"],
      objectives: [
        {
          id: "observe",
          description: "Explain a changing pattern.",
          prerequisites: [],
        },
      ],
      chapters: [
        {
          id: "begin",
          title: "Begin",
          episodes: [
            {
              id: "intro",
              title: "Notice the change",
              objectiveIds: ["observe"],
              gateId: "check",
              blocks: [
                {
                  id: "reading",
                  type: "text",
                  markdown:
                    "# Observe\n\nPatterns change. [Public reference](https://example.org/reference).",
                  sourceRefs: ["public", "private"],
                },
                { id: "picture", type: "visual", visualId: experience.id },
                {
                  id: "movie",
                  type: "media",
                  mediaId: "video",
                  required: true,
                },
              ],
            },
          ],
        },
      ],
      visuals: [experience as unknown as VisualExperience],
      media: [
        {
          id: "video",
          type: "youtube",
          sourceRef: "public",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          review: "reviewed",
          alternativeMarkdown: "A written explanation of the changing pattern.",
          generated: false,
        },
      ],
      sources: [
        {
          id: "public",
          title: "Public reading",
          url: "https://example.org/reference",
          reviewedAt: "2026-01-01",
        },
        {
          id: "private",
          title: "Course reference",
          url: "urn:private:do-not-display",
          reviewedAt: "2026-01-01",
        },
      ],
      policy: { mode: "bounded", existingMaterialAccess: "read_only" },
      assessments: [],
      extensions: [],
      gates: [
        {
          id: "check",
          objectiveIds: ["observe"],
          minimumIndependentFamilies: 2,
          requireAllObjectives: true,
        },
      ],
    },
  };
}
