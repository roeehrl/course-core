import { createRequire } from "node:module";
import { useEffect, useState } from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { pressWhenReady, reactIdle } from "./pressWhenReady";

/** A button that stays disabled until `job` settles, as a Save button does while its request runs. */
function Saver({ job, onPress }: { job: Promise<void>; onPress: () => void }) {
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    void job.then(() => setBusy(false));
  }, [job]);
  return (
    <Pressable role="button" disabled={busy} onPress={onPress}>
      <Text>Save</Text>
    </Pressable>
  );
}

const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const scheduler = createRequire(import.meta.url)("scheduler") as {
  unstable_scheduleCallback(priority: number, callback: () => void): unknown;
  unstable_UserBlockingPriority: number;
};

/** Queues work ahead of the pending effects, each task long enough to end the scheduler's turn, as
 * other renders do on a loaded machine. The effects then run only several scheduler turns later. */
function crowdScheduler(tasks = 3) {
  for (let i = 0; i < tasks; i++)
    scheduler.unstable_scheduleCallback(scheduler.unstable_UserBlockingPriority, () => {
      const end = performance.now() + 6;
      while (performance.now() < end);
    });
}

/** Settles the job outside act, the way a request settles while `waitFor` polls, and runs `atSight` in
 * the DOM change that enables the button: what `waitFor` sees first. React's scheduler yields after
 * that commit, so the render's passive effects have not run yet. */
async function enableOutsideAct(finish: () => void, button: HTMLElement, atSight: () => void | Promise<void>) {
  const before = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  let seen: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true") return;
        observer.disconnect();
        env.IS_REACT_ACT_ENVIRONMENT = before;
        seen = Promise.resolve(atSight());
        resolve();
      });
      observer.observe(button, { attributes: true });
      finish();
    });
    await seen;
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = before;
  }
}

function setup() {
  let finish = () => {};
  const job = new Promise<void>((resolve) => (finish = resolve));
  const onPress = vi.fn();
  const { unmount } = render(<Saver job={job} onPress={onPress} />);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button).toBeDisabled();
  return { finish, onPress, button, unmount };
}

describe("pressing a react-native-web button that async work has just enabled", () => {
  it("drops a click made as soon as the enabled button is in the page", async () => {
    const { finish, onPress, button } = setup();
    let enabledInPage = false;
    await enableOutsideAct(finish, button, () => {
      enabledInPage = !button.hasAttribute("disabled");
      fireEvent.click(button);
    });
    // The page showed the button enabled, yet its handler still held `disabled: true`.
    expect(enabledInPage).toBe(true);
    expect(onPress).not.toHaveBeenCalled();
    // Once React runs the render's effects, the same click is taken.
    await act(async () => {
      await reactIdle();
    });
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("still drops it after a macrotask or an empty act while the scheduler has other work queued", async () => {
    for (const settle of [() => new Promise((resolve) => setTimeout(resolve, 0)), () => act(async () => {})]) {
      const { finish, onPress, button, unmount } = setup();
      await enableOutsideAct(finish, button, async () => {
        crowdScheduler();
        await settle();
        fireEvent.click(button);
      });
      expect(onPress).not.toHaveBeenCalled();
      await act(async () => {
        await reactIdle();
      });
      unmount();
    }
  });

  it("takes the click through pressWhenReady at that same moment, however much work is queued", async () => {
    for (const tasks of [0, 3]) {
      const { finish, onPress, button, unmount } = setup();
      await enableOutsideAct(finish, button, () => {
        crowdScheduler(tasks);
        return pressWhenReady(button);
      });
      expect(onPress).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("uses the press it is given, once", async () => {
    const { finish, onPress, button } = setup();
    const press = vi.fn((target: Element) => fireEvent.click(target));
    await enableOutsideAct(finish, button, () => pressWhenReady(button, press));
    expect(press).toHaveBeenCalledExactlyOnceWith(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("refuses an element that has left the page instead of pressing nothing", async () => {
    const { button, unmount } = setup();
    unmount();
    await expect(pressWhenReady(button)).rejects.toThrow(/left the page/);
  });
});
