import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ChoiceList } from "../src/components/ui";
import { keepFocusClearOfAnswerActions } from "../src/connected/focusClear";
import { reactIdle } from "./pressWhenReady";

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Settles `job` outside act, as a request settles in the app, and presses in the DOM change that
 * shows the control enabled: the first moment a learner could see it. React's scheduler yields
 * after that commit, so the render's passive effects have not run yet. */
async function pressAtFirstSight(finish: () => void, target: () => HTMLElement, ready: (el: HTMLElement) => boolean, press: (el: HTMLElement) => void) {
  const before = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  let seenEnabled = false;
  try {
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        const el = target();
        if (!ready(el)) return;
        observer.disconnect();
        seenEnabled = true;
        press(el);
        resolve();
      });
      observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      finish();
    });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = before;
  }
  // Let React finish what is queued, so a dropped press cannot be mistaken for a slow one.
  await act(async () => {
    await reactIdle();
  });
  return seenEnabled;
}

function deferred() {
  let finish = () => {};
  const job = new Promise<void>((resolve) => (finish = resolve));
  return { job, finish };
}

/** Disabled until `job` settles, as "Check answer" is while a request runs. */
function SaveWhenReady({ job, onPress }: { job: Promise<void>; onPress: () => void }) {
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void job.then(() => setBusy(false));
  }, [job]);
  return <Button label="Check answer" kind="primary" disabled={busy} onPress={onPress} />;
}

/** A check whose options are locked until `job` settles, then answered through `onChange`. */
function LockedChoices({ job, onChange }: { job: Promise<void>; onChange: (id: string) => void }) {
  const [locked, setLocked] = useState(true);
  useEffect(() => {
    void job.then(() => setLocked(false));
  }, [job]);
  return (
    <ChoiceList label="Your answer" value="" disabled={locked} onChange={onChange}
      options={[{ id: "a", label: "Two" }, { id: "b", label: "Five" }]} />
  );
}

/** A button whose action changes when `job` settles, as a step's "Next" does. */
function NextStep({ job, onPress }: { job: Promise<void>; onPress: (step: number) => void }) {
  const [step, setStep] = useState(1);
  useEffect(() => {
    void job.then(() => setStep(2));
  }, [job]);
  return <Button label={`Go to step ${step + 1}`} onPress={() => onPress(step)} />;
}

describe("a learner control pressed right after async work changed it", () => {
  it("takes a press on a button the moment it is shown enabled", async () => {
    const { job, finish } = deferred(), onPress = vi.fn();
    render(<SaveWhenReady job={job} onPress={onPress} />);
    const button = () => screen.getByRole("button", { name: "Check answer" });
    expect(button()).toBeDisabled();
    const seen = await pressAtFirstSight(finish, button, (el) => !el.hasAttribute("disabled"), (el) => fireEvent.click(el));
    expect(seen).toBe(true);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("takes a press on an option the moment it is shown unlocked", async () => {
    const { job, finish } = deferred(), onChange = vi.fn();
    render(<LockedChoices job={job} onChange={onChange} />);
    const option = () => screen.getByRole("radio", { name: "Five" });
    expect(option()).toHaveAttribute("aria-disabled", "true");
    const seen = await pressAtFirstSight(finish, option, (el) => el.getAttribute("aria-disabled") !== "true", (el) => fireEvent.click(el));
    expect(seen).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("takes Enter on an option the moment it is shown unlocked", async () => {
    const { job, finish } = deferred(), onChange = vi.fn();
    render(<LockedChoices job={job} onChange={onChange} />);
    const option = () => screen.getByRole("radio", { name: "Two" });
    await pressAtFirstSight(finish, option, (el) => el.getAttribute("aria-disabled") !== "true", (el) => fireEvent.keyDown(el, { key: "Enter" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("runs the action the page shows, not the one of the render before", async () => {
    const { job, finish } = deferred(), onPress = vi.fn();
    render(<NextStep job={job} onPress={onPress} />);
    await pressAtFirstSight(finish, () => screen.getByRole("button"), (el) => el.textContent === "Go to step 3", (el) => fireEvent.click(el));
    expect(onPress).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("still ignores a disabled button and a locked option", () => {
    const onPress = vi.fn(), onChange = vi.fn();
    render(
      <>
        <Button label="Check answer" disabled onPress={onPress} />
        <ChoiceList label="Your answer" value="" disabled onChange={onChange} options={[{ id: "a", label: "Two" }]} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check answer" }));
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    fireEvent.keyDown(screen.getByRole("radio", { name: "Two" }), { key: "Enter" });
    expect(onPress).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Check answer" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Two" })).toHaveAttribute("tabindex", "-1");
  });
});

describe("focus kept clear of the sticky answer actions", () => {
  let stop = () => {};
  afterEach(() => stop());
  /** An option whose lower part runs on under the answer actions. */
  function lesson() {
    document.body.innerHTML = `<div class="connected-lesson-keeper"><div role="radio" tabindex="0">Five</div>
      <div class="connected-answer-actions"><button>Check answer</button></div></div>`;
    const option = document.querySelector<HTMLElement>('[role="radio"]')!, bar = document.querySelector<HTMLElement>(".connected-answer-actions")!;
    option.getBoundingClientRect = () => ({ top: 516, bottom: 672, left: 39, right: 351, width: 312, height: 156, x: 39, y: 516 }) as DOMRect;
    bar.getBoundingClientRect = () => ({ top: 599, bottom: 731, left: 29, right: 361, width: 332, height: 132, x: 29, y: 599 }) as DOMRect;
    const scrollBy = vi.fn(), focused = vi.fn();
    stop = keepFocusClearOfAnswerActions(() => ({ scrollBy }), focused);
    return { option, scrollBy, focused };
  }

  it("scrolls keyboard or script focus out from under them", () => {
    const { option, scrollBy, focused } = lesson();
    option.focus();
    expect(focused).toHaveBeenCalledWith(option);
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 672 - 599 + 12, behavior: "instant" });
  });

  it("leaves the focus a press gives where it is, so the release lands on the same option", async () => {
    vi.useFakeTimers();
    try {
      const { option, scrollBy, focused } = lesson();
      // A mouse press or a tap: mousedown, then (its default action) focus, in the same task.
      fireEvent.mouseDown(option);
      option.focus();
      expect(focused).toHaveBeenCalledWith(option);
      expect(scrollBy).not.toHaveBeenCalled();
      // Focus that comes later, not from that press, is kept clear again.
      vi.runAllTimers();
      option.blur();
      option.focus();
      expect(scrollBy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("learner controls on web do not use react-native's Pressable", () => {
  it("routes every pressable on the web app through LivePressable", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
    const offenders = files(src).filter((file) => {
      if (path.basename(file) === "LivePressable.tsx" || /\.(native|ios|android)\.tsx?$/.test(file)) return false;
      // A module with a `.web` twin is the native app's only; the web export takes the twin.
      const web = file.replace(/\.(tsx?)$/, ".web.$1");
      if (!/\.web\.tsx?$/.test(file) && (existsSync(web) || existsSync(web.replace(/\.tsx$/, ".ts")))) return false;
      return /\bimport\s*\{[^}]*\bPressable\b[^}]*\}\s*from\s*["']react-native["']/.test(readFileSync(file, "utf8"));
    });
    expect(offenders.map((file) => path.relative(src, file))).toEqual([]);
  });
});
