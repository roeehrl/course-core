import type { LearnerView } from "../src/domain/learnerView";

export const enrollmentId = "6b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60";
/** A complete read-only learner view, shared by the unit and browser tests. */
export function sample(): LearnerView {
  return {
    readOnly: true,
    view: {
      id: "0b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f61",
      viewedAt: "2026-10-14T10:00:00.000Z",
      viewer: { id: "owner", name: "Owner", role: "owner" },
      visibleToLearner: true,
    },
    learner: {
      displayName: "Sam",
      goal: "Compare values with confidence.",
      pace: "steady",
    },
    snapshot: {
      enrollmentId,
      revision: 4,
      status: "active",
      profile: { displayName: "Sam" },
      planRevision: 0,
      adaptationRequirements: [],
      lessons: [
        {
          id: "one",
          requirement: "required",
          status: "available",
          completedBlockIds: ["one-text"],
          gate: {
            passed: false,
            objectives: [
              { id: "o1", families: ["a"], required: 2, passed: false },
            ],
          },
        },
        {
          id: "two",
          requirement: "required",
          status: "locked",
          completedBlockIds: [],
          gate: null,
        },
      ],
      complete: false,
      nextEpisodeId: "one",
      course: {
        title: "Public course",
        summary: "",
        objectives: [{ id: "o1", description: "Compare values." }],
        chapters: [
          {
            id: "c",
            title: "Chapter",
            episodes: [
              {
                id: "one",
                title: "First lesson",
                objectiveIds: ["o1"],
                blocks: [
                  {
                    id: "one-text",
                    type: "text",
                    markdown: "Hello **world** <script>x</script>",
                  },
                ],
                gateId: "g",
              },
              {
                id: "two",
                title: "Second lesson",
                objectiveIds: ["o1"],
                blocks: [{ id: "two-text", type: "text", markdown: "Later." }],
              },
            ],
          },
        ],
        visuals: [],
        media: [],
        sources: [],
      },
      recovery: [],
      inaccessibleEpisodeIds: [],
      closureReport: null,
      activeChallenges: [
        {
          challengeId: "1b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f62",
          episodeId: "one",
          question: {
            id: "q",
            type: "choice",
            prompt: "Which is smaller?",
            options: [
              { id: "a", text: "2" },
              { id: "b", text: "5" },
            ],
          },
          mode: "independent",
          independentEligible: true,
          expiresAt: "2026-10-14T11:00:00.000Z",
        },
      ],
    },
    personalChanges: [],
    reviews: [],
    generatedMedia: [],
    withheld: [
      { id: "companion", label: "Companion conversation", reason: "Private." },
    ],
  };
}
