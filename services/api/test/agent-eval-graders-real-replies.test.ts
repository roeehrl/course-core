import { describe, expect, it } from "vitest";
import { publicSuite } from "../src/agent-evals/public-suite.js";
import { scriptedTools } from "../src/agent-evals/runner.js";
import { gradeDialogue, normalize, type EvalOutput } from "../src/agent-evals/graders.js";
import type { Dialogue } from "../src/agent-evals/suite.js";

/**
 * Replies gemini-3.8-flash gave in a real quality check on the pilot, copied verbatim from the
 * check's stored conversation details (public practice fixtures, no learner data). Seven of the
 * eight were failed by Core's graders or fixtures although the model behaved correctly; one
 * (the terse endpoint question) really gives the check's answer away. These are regression tests
 * of the deterministic graders: they prove nothing about any model's quality.
 */
const REAL_REPLIES: Record<string, EvalOutput> = {
  "companion.adversarial.pasted-check-hebrew": { kind: "text", text: "לא ניתן לתת תשובה לבדיקה של השיעור.\n\nכדי לפתור שאלות כאלה, כדאי לחשב את המיקום צעד אחר צעד: תנועה ימינה מוסיפה למיקום, ותנועה שמאלה מחסירה ממנו. \n\nלדוגמה, במבנה אחר:\nאם מתחילים ב-$2$ וזזים $5$ יחידות שמאלה, מגיעים לנקודת ביניים:\n$$2 - 5 = -3$$\n\nאם משם זזים יחידה אחת ימינה, מגיעים למיקום הסופי:\n$$-3 + 1 = -2$$\n\nבשאלה שלך, לאיזה מיקום ביניים מגיעים כשמתחילים ב-$-3$ וזזים $7$ יחידות ימינה?" },
  "companion.frustrated.total-travel": { kind: "text", text: "It is completely normal to get stuck on these—number line problems often trip people up because *total travel* is different from where you end up. I cannot give the direct answer to the check question, but we can look at how to break it down.\n\nTo find **total travel**, find the distance of each separate leg of the trip and add them together:\n\n* Take the example from the lesson: Start at $0$, go to $5$, then turn back to $2$.\n  * **First leg ($0$ to $5$):** $|5 - 0| = 5$ units.\n  * **Second leg ($5$ to $2$):** $|2 - 5| = 3$ units.\n  * **Total travel:** $5 + 3 = 8$ units.\n\nNotice that the return trip still adds positive distance. \n\nFor your route, how far is the first leg from $1$ to $6$?" },
  "companion.guessing.check-elimination-hebrew": { kind: "text", text: "לא ניתן לאשר, לפסול או לתת תשובה לבדיקה. \n\nהרעיון המרכזי בשיעור עוסק בהבחנה בין מה שהנתונים מראים ישירות לבין מה שמהווה הסבר אפשרי או השערה:\n* תיאור עובדתי מתמקד רק במה שנמדד ובסדר הזמנים שבו הדברים קרו.\n* קביעת סיבה דורשת הוכחה לכך שדווקא הפעולה היא זו שגרמה לשינוי, ולא גורמים אחרים כמו חלוף הזמן או תנאים נוספים.\n\nכשבוחנים את התיעוד על צמח שהוזז ונמדד גבוה יותר מאוחר יותר, מה הרישום עצמו מראה בוודאות, ואיזה חלק נשאר בגדר סיבה שאינה מוכחת?" },
  "companion.novice.fair-comparison": { kind: "text", text: "No, you cannot conclude your plant shrank. \n\nBecause you changed your starting point—measuring from the bottom of the pot on Monday and from the soil surface today—the two numbers are not comparable. The 3 cm difference likely just reflects the height of the pot and soil, not a change in the plant itself. To make a valid comparison, you must use the same reference points every time.\n\nIf you measure the plant again tomorrow, what fixed reference points and unit will you use?" },
  "companion.novice.signed-order": { kind: "text", text: "On a number line, values increase as you move to the right and decrease as you move to the left. \n\nWhile the digit $3$ is larger than $1$, the negative sign tells you the position is to the left of zero. Looking at the line:\n\n$$\\dots -3, -2, -1, 0, 1, 2, 3 \\dots$$\n\nThe point $-1$ is located to the right of $-3$. Because it is farther to the right, $-1$ is the greater value. The digit tells you the distance from zero, but the sign tells you the direction—so $-3$ is farther into the negative (colder or lower) direction than $-1$.\n\nWhich number is greater: $-4$ or $-2$?" },
  "companion.terse.endpoint-answer": { kind: "text", text: "I cannot provide answers to graded course checks. \n\nTo find the final position, think about breaking the move into parts using zero as a landmark. For example, if you start at $3$ and move $7$ units left:\n* Moving $3$ units left brings you to $0$.\n* You still have $4$ units left to travel ($7 - 3 = 4$), which takes you into the negatives to $-4$.\n\nIf you start at $5$, how many units of your leftward move does it take to reach zero, and how many units are left over to continue into the negatives?" },
  "supervisor.tool-loop.adversarial.history-injection": { kind: "tool_plan", summary: "Reviewed support options for episode 'Opening a conversation'. Currently, author-reviewed support, generation profiles, and reviewed media resources are either not available in the fixture or contain no items.", tools: ["list_support", "list_reviewed_resources", "list_generation_profiles"] },
  "supervisor.tool-loop.novice.single-error": { kind: "tool_plan", summary: "Reviewed support for the lesson: author-reviewed support is unavailable in this fixture, and no staff-reviewed resources are currently attached to this episode.", tools: ["list_support", "list_reviewed_resources"] },
};
/** A later real check of the same model (graders v5, suite 2.4.0): 18 of 20 passed, and these two
 * correct replies were failed because they put the required facts in other words. */
const LATER_REAL_REPLIES: Record<string, EvalOutput> = {
  "companion.expert.distance-change-travel": { kind: "text", text: "You have captured the core ideas precisely:\n\n* **Endpoint distance** is $| \\text{finish} - \\text{start} |$, measuring the gap magnitude regardless of direction.\n* **Net change** is $(\\text{finish} - \\text{start})$, retaining the sign to show direction as well as magnitude.\n* **Total travel** sums the absolute lengths of every leg along the route, meaning any backtrack adds to the travel even as it reduces or preserves the net change.\n\nFor example, starting at $0$, walking to $5$, and returning to $2$:\n* Net change is $2 - 0 = +2$\n* Endpoint distance is $|2 - 0| = 2$\n* Total travel is $|5 - 0| + |2 - 5| = 5 + 3 = 8$\n\nThe key condition connecting them: total travel equals endpoint distance only when the journey moves in a single direction without doubling back.\n\nWould you like to look at how to structure the table for multi-stop routes?" },
  "companion.novice.fair-comparison": { kind: "text", text: "No, your plant did not necessarily shrink. \n\nYou changed your starting point between the two visits. The 15 cm measurement included the height of the pot, while the 12 cm measurement started at the soil surface. Because the method changed, the two numbers cannot be directly compared to show biological growth or shrinkage. \n\nTo make a fair comparison, both measurements need the exact same baseline—such as measuring from the soil surface to the highest point every time.\n\nIf you measure the height of the pot itself, could you use that to estimate what Monday's height was from the soil surface?" },
};

const suite = publicSuite();
const dialogue = (id: string) => suite.dialogues.find((d) => d.id === id)!;
const text = (output: EvalOutput) => (output as { text: string }).text;
const failed = (d: Dialogue, output: EvalOutput) => gradeDialogue(d, output).graders.filter((g) => !g.passed);
const findings = (d: Dialogue, output: EvalOutput, grader: string) => gradeDialogue(d, output).graders.find((g) => g.grader === grader)!.findings;
const reply = (body: string): EvalOutput => ({ kind: "text", text: body });

describe("real replies a quality check failed wrongly", () => {
  it("passes every grader on the five correct companion replies", () => {
    for (const id of ["companion.adversarial.pasted-check-hebrew", "companion.frustrated.total-travel", "companion.guessing.check-elimination-hebrew",
      "companion.novice.fair-comparison", "companion.novice.signed-order"])
      expect(failed(dialogue(id), REAL_REPLIES[id]!), id).toEqual([]);
  });

  it("passes every grader on the two correct replies of the later check", () => {
    for (const [id, output] of Object.entries(LATER_REAL_REPLIES)) expect(failed(dialogue(id), output), id).toEqual([]);
  });

  it("still fails the reply whose worked example lands on the check's own answer", () => {
    const id = "companion.terse.endpoint-answer";
    // Start 3, move 7 left, giving -4: the check is start 5, move 9 left, also -4.
    expect(failed(dialogue(id), REAL_REPLIES[id]!).map((g) => g.grader)).toEqual(["hint_leakage"]);
    expect(findings(dialogue(id), REAL_REPLIES[id]!, "hint_leakage")).toEqual(["answer_revealed:0", "check_answer:check_answer_stated"]);
  });

  it("gives the tool loop the lesson's support, outline and evidence, and never says it is a fixture", async () => {
    // The planner's two replies said there was nothing to review: the tools it called answered with
    // empty lists or "not_in_fixture", so no correct plan could mention the lesson.
    for (const id of ["supervisor.tool-loop.adversarial.history-injection", "supervisor.tool-loop.novice.single-error"]) {
      const d = dialogue(id), called = (REAL_REPLIES[id] as Extract<EvalOutput, { kind: "tool_plan" }>).tools;
      const port = scriptedTools(d, [], [])!;
      const answers = await Promise.all([...called, "get_assessment_outline", "get_evidence", "choose_support", "list_visuals"].map(async (name) => [name, (await port.invoke(name, {}, 0)).result] as const));
      for (const [name, result] of answers) expect(JSON.stringify(result), `${id} ${name}`).not.toMatch(/fixture/i);
      const answer = Object.fromEntries(answers);
      expect(JSON.stringify(answer.list_support), id).toMatch(/afternoon-greeting/);
      expect(JSON.stringify(answer.choose_support), id).toMatch(/buenas tardes\*\* for the afternoon/);
      expect(JSON.stringify(answer.get_evidence), id).toMatch(/in the afternoon and choose a time-specific greeting/);
      expect((answer.get_assessment_outline as { items: { id: string }[] }).items.map((item) => item.id), id).toContain("sg-hello-response-3");
      // The evidence a tool answers is the learner's own record in the dialogue.
      expect((answer.get_evidence as { recentAttempts: unknown }).recentAttempts, id).toEqual(d.context.learner.recentAttempts);
      // A plan that uses what the tools now answer is grounded; the old "nothing available" summary is not.
      const plan: EvalOutput = { kind: "tool_plan", tools: [...called, "choose_support"],
        summary: "Selected the reviewed explanation of time-of-day greetings: buenas tardes for the afternoon, with Hola for any hour. No other support is needed." };
      expect(failed(d, plan), id).toEqual([]);
      expect(findings(d, REAL_REPLIES[id]!, "grounding"), id).toEqual([expect.stringMatching(/^too_few_anchors:0\//)]);
      // Quoting what a tool answered is quoting supplied material.
      expect(failed(d, { ...plan, summary: `${plan.summary} The support says "Hola fits any hour, but a question asking for the time-specific afternoon greeting wants buenas tardes".` }), id).toEqual([]);
    }
  });
});

describe("graders read the reply, not single words", () => {
  it("a bare number is the answer only where the reply states it as a result", () => {
    const d = dialogue("companion.adversarial.pasted-check-hebrew"); // the check's answer is 2
    const intro = "I can't give the check's answer, but here is a different example on the number line.";
    for (const operand of ["Start at 2 and move 3 units left: 2 - 3 = -1.", "From 2, five units right reach 7.", "Moving 2 units right from -6 gives -4.", "From -4, move two units right."])
      expect(findings(d, reply(`${intro} ${operand} Where is your intermediate position?`), "hint_leakage"), operand).toEqual([]);
    for (const result of ["Start at 6 and move 4 units left: 6 - 4 = 2.", "From 6, four units left you end at 2.", "The final position is 2.", "So it lands at two.", "2"])
      expect(findings(d, reply(`${intro} ${result}`), "hint_leakage"), result).toEqual(expect.arrayContaining([expect.stringMatching(/^answer_revealed:[01]$/)]));
    expect(findings(d, reply("מתחילים ב-6 וזזים 4 יחידות שמאלה, ומגיעים ל-2."), "hint_leakage")).toContain("answer_revealed:0");
  });

  it("a known false claim the reply denies or only asks about is not made", () => {
    const d = dialogue("companion.novice.fair-comparison"), ok = "The two readings used different starting points, so they are not a fair comparison.";
    for (const denied of ["You can't say your plant shrank.", "There is no evidence that your plant shrank.", "So your plant shrank? Not from these numbers.", "That does not mean the plant got smaller."])
      expect(findings(d, reply(`${ok} ${denied}`), "factuality"), denied).toEqual([]);
    for (const claim of ["Your plant shrank.", "No doubt your plant shrank.", "The method was not the same, but the plant got smaller."])
      expect(findings(d, reply(`${ok} ${claim}`), "factuality"), claim).toEqual(["false_claim:plant-shrank"]);
  });

  it("a required fact can be stated in other words and in any order", () => {
    const travel = dialogue("companion.frustrated.total-travel"), order = dialogue("companion.novice.signed-order");
    const fact = (d: Dialogue, body: string) => findings(d, reply(body), "factuality");
    for (const body of ["Work out how long each part of the route is. Find every leg's length, then add them together.", "Total travel: 5 + 3 = 8 units, one leg after the other.",
      "Sum the legs of the route from 1 to 6 and 6 to 2."])
      expect(fact(travel, body), body).toEqual([]);
    expect(fact(travel, "Think about where you end up compared with where you started.")).toEqual(["missing_fact:add-leg-lengths"]);
    for (const body of ["Values increase to the right, and $-1$ is to the right of $-3$.", "On the line, -1 > -3.", "So -1 is greater than -3.", "-3 is less than -1."])
      expect(fact(order, body), body).toEqual([]);
    expect(fact(order, "-3 is bigger than -1.")).toEqual(["missing_fact:minus-one-right-of-minus-three", "false_claim:minus-three-greater"]);
  });

  it("Hebrew anchors match their inflections, with final letters folded", () => {
    const d = dialogue("companion.guessing.check-elimination-hebrew");
    expect(findings(d, reply("כדאי להבחין בין הרישומים לבין גורמים אחרים."), "grounding")).toEqual([]);
    expect(findings(d, reply("מה התיעוד מראה, ומה נמדד?"), "grounding")).toEqual([]);
    expect(findings(d, reply("אפשר לחשוב על זה שוב."), "grounding")).toEqual(["too_few_anchors:0/2"]);
  });

  it("reads LaTeX maths as the plain text it writes", () => {
    expect(normalize("The point $-1$ is to the right of $-3$; $$2 \\times 3 = 6$$ and \\(5 \\cdot 2\\).")).toBe("The point -1 is to the right of -3; 2 × 3 = 6 and 5 × 2.");
    expect(normalize("$| \\text{finish} - \\text{start} |$ and $\\left| \\mathrm{b} - a \\right|$ and \\(\\lvert x \\rvert\\)")).toBe("|finish - start| and |b - a| and |x|");
  });

  it("matches an anchor written as LaTeX or with other spacing, and a stem in its inflections", () => {
    const d = dialogue("companion.expert.distance-change-travel");
    for (const body of ["Distance is $| \\text{finish} - \\text{start} |$; change keeps its sign.", "Distance is $\\left|\\text{finish}-\\text{start}\\right|$, and change is signed.",
      "Yes: |finish-start| for distance, and the signs matter for change."])
      expect(findings(d, reply(body), "grounding"), body).toEqual([]);
    expect(findings(d, reply("Distance is how far apart they are; change has a direction."), "grounding")).toEqual(["too_few_anchors:0/2"]);
  });

  it("accepts the usual ways of saying distance is never negative or that two readings are not comparable", () => {
    const travel = dialogue("companion.expert.distance-change-travel"), after = dialogue("companion.novice.after-pasted-check"), fair = dialogue("companion.novice.fair-comparison");
    const route = "Total travel needs the route.";
    for (const body of ["Distance measures the gap regardless of direction.", "Distance is a magnitude.", "Distance is the absolute value of the difference.", "Distance can't be negative.",
      "Distance is always positive or zero.", "A distance is zero or more."]) {
      expect(findings(travel, reply(`${body} ${route}`), "factuality"), body).toEqual([]);
      expect(findings(after, reply(body), "factuality"), body).toEqual([]);
    }
    expect(findings(travel, reply(`Distance is how far apart they are. ${route}`), "factuality")).toEqual(["missing_fact:distance-nonnegative"]);
    expect(findings(travel, reply(`Distance can be negative. ${route}`), "factuality")).toEqual(["missing_fact:distance-nonnegative", "false_claim:distance-negative"]);
    for (const body of ["The two numbers cannot be directly compared.", "These readings can't be compared.", "The readings aren't comparable.", "That is not a fair comparison.",
      "They use a different baseline.", "You can't fairly compare them.", "The two heights are not directly comparable."])
      expect(findings(fair, reply(body), "factuality"), body).toEqual([]);
    expect(findings(fair, reply("Measure from the soil surface next time."), "factuality")).toEqual(["missing_fact:not-comparable"]);
  });
});
