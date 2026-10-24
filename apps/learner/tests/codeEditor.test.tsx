import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor } from "../src/components/CodeEditor.web";
import {
  ConnectedLesson,
  type ConnectedLessonProps,
} from "../src/connected/ConnectedLesson.web";
import {
  codeSubmissionError,
  MAX_CODE_BYTES,
  utf8Bytes,
} from "../src/connected/code";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { connectedSnapshot } from "./connectedFixtures";
const source = "def solve(input):\n    return input\n";
function lesson(language = "python"): ConnectedLessonProps {
  const server = connectedSnapshot();
  server.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
  server.activeChallenges = [
    {
      challengeId: "code-1",
      episodeId: "intro",
      independentEligible: true,
      mode: "independent",
      question: {
        id: "program",
        type: "code",
        language,
        starterCode: source,
        prompt: "Implement solve(input). Return the reversed JSON list.",
      },
    },
  ];
  return {
    server,
    episode: server.course.chapters[0]!.episodes[0]!,
    placement: false,
    pending: false,
    now: Date.now(),
    answer: source,
    onAnswerChange: vi.fn(),
    onRead: vi.fn(),
    onStart: vi.fn(),
    onAnswer: vi.fn(),
    onSolution: vi.fn(),
    onComplete: vi.fn(),
    onNormal: vi.fn(),
    onRefresh: vi.fn(),
    onBlockChange: vi.fn(),
  };
}
describe("connected practical exercise editor", () => {
  it("uses inert multiline source, disables corrections, and explains the server protocol", () => {
    const change = vi.fn();
    const { container } = render(
      <CodeEditor
        language="python"
        value={source + "# <script>alert(1)</script>"}
        onChange={change}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "Your code" });
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveAttribute("autocapitalize", "off");
    expect(editor).toHaveAttribute("autocorrect", "off");
    expect(editor).toHaveAttribute("spellcheck", "false");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/runner handles serialization/)).toBeVisible();
    fireEvent.change(editor, {
      target: { value: "def solve(input):\n    return None\n" },
    });
    expect(change).toHaveBeenCalledWith("def solve(input):\n    return None\n");
  });
  it("bounds UTF-8 bytes, including non-ASCII and malformed surrogate inputs", () => {
    expect(utf8Bytes("aé🙂\ud800")).toBe(10);
    expect(
      codeSubmissionError("python", "x".repeat(MAX_CODE_BYTES)),
    ).toBeUndefined();
    expect(
      codeSubmissionError("python", "é".repeat(MAX_CODE_BYTES / 2 + 1)),
    ).toMatch(/exceeds/);
    expect(codeSubmissionError("javascript", source)).toMatch(/unsupported/);
    expect(codeSubmissionError("python", " \n")).toMatch(/Enter/);
  });
  it("does not turn an unsupported code language into a numeric answer or a pass", () => {
    const p = lesson("javascript");
    render(<ConnectedLesson {...p} />);
    expect(screen.getByRole("textbox", { name: "Your code" })).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Your numeric answer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Run code & check" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Complete episode →" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Run code & check" }));
    expect(p.onAnswer).not.toHaveBeenCalled();
    expect(screen.queryByText(/passed/)).not.toBeInTheDocument();
  });
  it("submits only on explicit action and displays pending without inventing results", () => {
    const p = lesson();
    const { rerender } = render(<ConnectedLesson {...p} />);
    expect(p.onAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run code & check" }));
    expect(p.onAnswer).toHaveBeenCalledWith(p.server.activeChallenges[0]);
    rerender(<ConnectedLesson {...p} pending checkingAnswer />);
    expect(
      screen.getByRole("button", { name: "Checking code…" }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Your code" })).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByText(/Waiting for the server grader/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Complete episode →" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: "Show explanation · switch to practice",
      }),
    ).not.toBeInTheDocument();
  });
  it("imports bounded UTF-8 source and leaves the draft unchanged for oversized or invalid files", async () => {
    const change = vi.fn();
    render(<CodeEditor language="python" value={source} onChange={change} />);
    const input = screen.getByLabelText("Choose Python source file");
    const file = {
      name: "solution.py",
      size: source.length,
      arrayBuffer: async () => new TextEncoder().encode(source).buffer,
    };
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(change).toHaveBeenCalledWith(source));
    change.mockClear();
    fireEvent.change(input, {
      target: { files: [{ ...file, size: MAX_CODE_BYTES + 1 }] },
    });
    await screen.findByText(/no larger than/);
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(input, {
      target: {
        files: [
          { ...file, arrayBuffer: async () => new Uint8Array([0xff]).buffer },
        ],
      },
    });
    await screen.findByText(/not valid UTF-8/);
    expect(change).not.toHaveBeenCalled();
  });
  it("does not let a delayed file read overwrite newer typing", async () => {
    let resolve!: (data: ArrayBuffer) => void;
    const change = vi.fn();
    render(<CodeEditor language="python" value={source} onChange={change} />);
    fireEvent.change(screen.getByLabelText("Choose Python source file"), {
      target: {
        files: [
          {
            name: "old.py",
            size: 10,
            arrayBuffer: () =>
              new Promise<ArrayBuffer>((r) => {
                resolve = r;
              }),
          },
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Your code" }), {
      target: { value: "new draft" },
    });
    await act(async () => {
      resolve(new TextEncoder().encode("old file").buffer);
    });
    expect(change.mock.calls).toEqual([["new draft"]]);
  });
  it("persists code beyond the chat limit and distinguishes an empty saved draft from an untouched starter", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      removeItem: (k: string) => {
        values.delete(k);
      },
    };
    const key = '["enrollment","digest"]:code-answer:challenge';
    const a = createConnectedDraftStore("a", storage);
    const large = "# long solution\n" + "#".repeat(20_000);
    a.write(key, large);
    const reloaded = createConnectedDraftStore("a", storage);
    expect(reloaded.read(key)).toBe(large);
    expect(reloaded.has(key)).toBe(true);
    reloaded.write(key, "");
    expect(createConnectedDraftStore("a", storage).has(key)).toBe(true);
    expect(createConnectedDraftStore("a", storage).read(key)).toBe("");
    expect(createConnectedDraftStore("b", storage).has(key)).toBe(false);
    expect(reloaded.has(key + "different")).toBe(false);
  });
});

it("renders server run failures and refuses inconsistent or malformed pass receipts", async () => {
  const { answerFeedback } = await import("../src/connected/answerFeedback");
  expect(
    answerFeedback({
      result: {
        passed: false,
        explanation: "Time limit reached. No credit was granted.",
        independent: true,
        execution: { status: "timeout" },
      },
    }),
  ).toBe("Code check did not pass. Time limit reached. No credit was granted.");
  expect(() =>
    answerFeedback(
      {
        result: {
          passed: "true",
          explanation: "Claimed pass",
          independent: true,
        },
      },
      true,
    ),
  ).toThrow();
  expect(() =>
    answerFeedback({
      result: {
        passed: true,
        explanation: "Claimed pass",
        independent: true,
        execution: { status: "timeout" },
      },
    }),
  ).toThrow();
});

it("words Core's coded answer feedback in English and Hebrew and refuses unknown or malformed codes", async () => {
  const { answerFeedback } = await import("../src/connected/answerFeedback");
  const { createLearnerTranslator } = await import("../src/i18n");
  const { stripBidiControls } = await import("@course-core/i18n");
  const hebrew = createLearnerTranslator("he").t;
  const he = ((...args: Parameters<typeof hebrew>) => stripBidiControls(hebrew(...args))) as typeof hebrew;
  const code = (message: unknown, passed = false) => ({
    result: { passed, independent: true, message, execution: { status: passed ? "graded" : "timeout" } },
  });
  expect(answerFeedback(code({ code: "code_limit", params: { limit: "time" } }))).toBe(
    "Code check did not pass. The submission did not finish within the time limit. No credit was granted.",
  );
  expect(answerFeedback(code({ code: "code_limit", params: { limit: "time" } }), false, he)).toBe(
    "בדיקת הקוד לא עברה. ההרצה לא הסתיימה בתוך מגבלת הזמן. לא ניתן קרדיט.",
  );
  expect(answerFeedback(code({ code: "code_all_matched", params: { total: 3 } }, true), false, he)).toContain("כל 3 מקרי הבדיקה הנסתרים התאימו.");
  expect(answerFeedback(code({ code: "code_all_matched", params: { total: 3 } }, true))).toBe("Code check passed. All 3 hidden reference cases matched.");
  const pending = { result: { passed: false, pendingReview: true, independent: true, message: { code: "pending_review" } } };
  expect(answerFeedback(pending, false, he)).not.toMatch(/[A-Za-z]{3}/);
  const abstained = { result: { passed: false, abstained: true, independent: true, message: { code: "abstained" } } };
  expect(answerFeedback(abstained, false, he)).not.toMatch(/[A-Za-z]{3}/);
  expect(answerFeedback(code({ code: "made_up" }), false, he)).toContain("(קוד made_up)");
  for (const message of [
    { code: "Made up" },
    "All 3 hidden reference cases matched.",
    { code: "code_limit", params: { limit: "patience" } },
    { code: "code_some_matched", params: { passed: "2", total: 3 } },
  ])
    expect(() => answerFeedback(code(message), false, he)).toThrow();
});
