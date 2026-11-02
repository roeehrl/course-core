import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Gender-neutral Hebrew on the AI surfaces the companion redesign wrote (final design §7, COPY-7):
// no slashed verb or adjective (אישר/ה, מסכים/ה, תלוי/ה), which a screen reader cannot say and
// which marks the reader's gender. Impersonal and passive forms are used instead ("ההסבר אושר
// בבדיקה"). Role nouns keep the slash the glossary prescribes for them (docs/i18n-glossary.md:
// מנהל/ת, כותב/ת, מדריך/ה). The frozen host namespaces (connectedHost, connectivity) are outside
// the redesign and are left to the owner's decision on extending this rule.
const REDESIGN = [
  "aboutCompanion", "answerFeedback", "askCompanionButton", "askFromLesson", "attachmentChips", "basedOn", "bubbleActions",
  "bubbleMenu", "checkCard", "checkFeedback", "chip", "codeBlock", "companion", "companionClient", "companionDock",
  "companionHeader", "companionRegion", "companionSheet", "companionStates", "companionTrigger", "companionTurn",
  "companionTurnFrame", "composer", "connectedAgentsPanel", "connectedCompanion", "connectedLesson", "conversation",
  "courseRoadmap", "courseVersionNotice", "creditCopy", "creditInfo", "creditNotice", "creditThreadLines", "decisionLine",
  "deferredQuestion", "deleteConfirm", "earlierMessages", "emptyState", "episodeResources", "explanationPanel", "gateDecision",
  "generatedComponent", "helpRow", "hintLadder", "jumpToLatest", "kindLine", "learnerMemoryPanel", "learnerTurn",
  "lessonRecovery", "longAnswerComposer", "markdownContent", "noticeSlot", "notices", "notifications", "openNotification",
  "panelSplitter", "partMenu", "pendingChanges", "personalChanges", "placeholder", "practiceRunner", "recovered",
  "replyActions", "replyChips", "replyMenu", "replyNudge", "replyRow", "replyStates", "reviewAssistConsent", "reviewStatus",
  "reviewedMedia", "selectionAttach", "sendConfirm", "sendStopButton", "shortcut", "studyConsent", "supervisionPanel",
  "supervisorRequests", "teachingHypothesesPanel", "thread", "threadLines", "turnState", "unverified", "visualBlock",
  "voteControls", "yourDataPanel",
];
/** Role nouns, which the glossary writes with a slash (people's roles name both genders). */
const ROLE_NOUNS = new Set(["מנהל/ת", "כותב/ת", "מדריך/ה", "מפעיל/ת", "לומד/ת", "חבר/ה"]);
const SLASHED = /[א-ת]+\/[א-ת]{1,3}(?![א-ת])/g;
const messages = (namespace: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, "../src/i18n/messages/he", `${namespace}.json`), "utf8"));
/** The word without a one-letter prefix (ה, ל, מ, ש, ב, ו, כ). */
const bare = (word: string) => (ROLE_NOUNS.has(word) ? word : word.replace(/^[הלמשבוכ]/, ""));

describe("gender-neutral Hebrew in the companion redesign", () => {
  it("has no slashed verb or adjective; role nouns keep their slash", () => {
    const found: string[] = [];
    for (const namespace of REDESIGN)
      for (const [key, text] of Object.entries(messages(namespace)))
        for (const [word] of text.matchAll(SLASHED)) if (!ROLE_NOUNS.has(bare(word))) found.push(`${namespace}.${key}: ${word}`);
    expect(found).toEqual([]);
  });

  it("says the check's and the gate's results without a second-person past verb (read as masculine by TTS)", () => {
    // סיימת, כתבת: unpointed, a Hebrew voice reads them as masculine (final design §7).
    expect(messages("checkCard")["check.doneIntro"]).toBe("השאלות של השיעור הזה הושלמו.");
    expect(messages("gateDecision")["msg.criterion.rubric.met"]).toBe("ההסבר שלך אושר בבדיקה, עם ציטוט מהתשובה.");
  });

  it("recognises what it is meant to reject", () => {
    expect([..."בודק/ת אישר/ה, אני מסכים/ה, תלוי/ה".matchAll(SLASHED)].map(([word]) => word)).toEqual(["בודק/ת", "אישר/ה", "מסכים/ה", "תלוי/ה"]);
    expect(ROLE_NOUNS.has(bare("ממנהל/ת"))).toBe(true);
    expect(ROLE_NOUNS.has(bare("אישר/ה"))).toBe(false);
  });
});
