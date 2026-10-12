import type { Course } from "../domain/types";

/** Public, hand-authored sample. This is not a private course or a live AI response. */
export const demoCourse: Course = {
  id: "sorting-demo",
  version: "1",
  title: "A little order.",
  subtitle: "Sorting, one small step at a time.",
  description:
    "Turn a handful of numbers into a clear idea. Learn to compare, swap, and spot a pattern you can use again.",
  sections: [
    {
      id: "foundations",
      title: "Make sense of the sequence",
      description: "Start with the smallest useful moves.",
      lessonIds: ["order", "swap"],
    },
    {
      id: "patterns",
      title: "See the bigger pattern",
      description: "Put those moves to work together.",
      lessonIds: ["pass"],
    },
  ],
  placement: {
    title: "Already know the basics?",
    description:
      "Try one optional demo check. You can place out of the first lesson and still revisit it. Or simply start at the beginning.",
    question: "Which sequence is in ascending order?",
    options: [
      { id: "ascending", label: "2, 4, 7, 9" },
      { id: "descending", label: "9, 7, 4, 2" },
      { id: "mixed", label: "2, 7, 4, 9" },
    ],
  },
  lessons: [
    {
      id: "order",
      title: "Find the order",
      description:
        "Recognize an ascending sequence and explain what makes it ordered.",
      minutes: 4,
      requirement: "required",
      steps: [
        {
          id: "notice",
          title: "Understand",
          kind: "reading",
          requirement: "required",
          eyebrow: "First, a small observation",
          heading: "Every number has a neighbor.",
          body: "In ascending order, each number is at least as large as the one before it. Read this sequence from left to right. One pair breaks the pattern.",
          diagram: {
            label: "A sequence to explore",
            values: [2, 7, 4, 9],
            caption:
              "The 7 is larger than its next neighbor, 4. That pair is out of order.",
          },
          companion: {
            idea: "Ascending means smallest to largest. Equal neighbors are allowed.",
            hint: "Compare just two neighbors at a time. You do not need to remember the whole sequence.",
          },
        },
        {
          id: "predict",
          title: "Predict",
          kind: "choice",
          requirement: "required",
          eyebrow: "Check your understanding",
          heading: "Which pair breaks the order?",
          body: "Take another look at 2, 7, 4, 9. Choose the neighboring pair that is out of ascending order.",
          options: [
            { id: "two-seven", label: "2 and 7" },
            { id: "seven-four", label: "7 and 4" },
            { id: "four-nine", label: "4 and 9" },
          ],
          companion: {
            idea: "An out-of-order pair has a larger number on the left.",
            hint: "Ask whether the left number is greater than the right number.",
          },
        },
        {
          id: "equal",
          title: "Explore",
          kind: "reading",
          requirement: "optional",
          eyebrow: "A short side path",
          heading: "What if two numbers are equal?",
          body: "A sequence can be ordered even when values repeat. In 2, 4, 4, 9, neither 4 is smaller than its left neighbor. No swap is needed.",
          diagram: {
            label: "Equal values are welcome",
            values: [2, 4, 4, 9],
            caption: "Ascending order is also called non-decreasing order.",
          },
          companion: {
            idea: "Optional exploration adds context. It never blocks the required path.",
            hint: "Try comparing 4 with 4: the left number is not greater.",
          },
        },
        {
          id: "explain",
          title: "Reflect",
          kind: "reflection",
          requirement: "required",
          eyebrow: "Make it your own",
          heading: "Describe the pattern.",
          body: "Writing a short explanation helps you notice what you understand.",
          prompt:
            "How would you check whether a sequence is in ascending order?",
          placeholder: "I would compare…",
          companion: {
            idea: "Use your own words. A useful explanation says what you compare and what you look for.",
            hint: "Start with: “For each pair of neighbors…” This demo records a reflection; it does not grade the meaning.",
          },
        },
      ],
    },
    {
      id: "swap",
      title: "Compare & swap",
      description:
        "Repair one out-of-order pair without changing the values in the sequence.",
      minutes: 3,
      requirement: "required",
      steps: [
        {
          id: "read",
          title: "Understand",
          kind: "reading",
          requirement: "required",
          eyebrow: "One useful move",
          heading: "Trade places. Keep the numbers.",
          body: "When two neighbors are out of order, swap their positions. Swapping 7 and 4 turns 2, 7, 4, 9 into 2, 4, 7, 9.",
          diagram: {
            label: "After one swap",
            values: [2, 4, 7, 9],
            caption:
              "The values are the same. Only their positions have changed.",
          },
          companion: {
            idea: "A swap changes positions, not values.",
            hint: "Imagine exchanging two cards on a table.",
          },
        },
        {
          id: "check",
          title: "Apply",
          kind: "choice",
          requirement: "required",
          eyebrow: "Try a new pair",
          heading: "What comes after this swap?",
          body: "Start with 5, 3, 8. Swap the first two numbers.",
          options: [
            { id: "correct", label: "3, 5, 8" },
            { id: "reverse", label: "8, 3, 5" },
            { id: "unchanged", label: "5, 3, 8" },
          ],
          companion: {
            idea: "Only the selected pair changes places.",
            hint: "The 8 stays where it is.",
          },
        },
      ],
    },
    {
      id: "pass",
      title: "Follow one full pass",
      description:
        "Follow a large value as successive comparisons carry it to the right.",
      minutes: 3,
      requirement: "required",
      steps: [
        {
          id: "read",
          title: "Understand",
          kind: "reading",
          requirement: "required",
          eyebrow: "Connect the moves",
          heading: "A big value travels right.",
          body: "Start with 5, 3, 2. Compare 5 and 3, then swap: 3, 5, 2. Next compare 5 and 2, then swap: 3, 2, 5. The largest value has reached the end, but the whole sequence is not sorted yet.",
          diagram: {
            label: "After one left-to-right pass",
            values: [3, 2, 5],
            caption:
              "One pass puts the largest value at the end. Another pass may still be needed.",
          },
          companion: {
            idea: "A pass is one sweep through neighboring pairs.",
            hint: "Notice that 3 and 2 are still out of order.",
          },
        },
        {
          id: "check",
          title: "Predict",
          kind: "choice",
          requirement: "required",
          eyebrow: "Finish the idea",
          heading: "Is one pass always enough?",
          body: "After the pass, the sequence is 3, 2, 5. What needs to happen next?",
          options: [
            {
              id: "more",
              label: "Another pass: 3 and 2 are still out of order.",
            },
            { id: "done", label: "Nothing: the sequence is fully sorted." },
          ],
          companion: {
            idea: "Check all the neighbors before calling a sequence sorted.",
            hint: "Look at the first two values.",
          },
        },
      ],
    },
  ],
};

/** Answer keys belong exclusively to this local demo adapter, never production UI. */
export const demoAnswers: Record<string, string> = {
  "order/predict": "seven-four",
  "swap/check": "correct",
  "pass/check": "more",
};
