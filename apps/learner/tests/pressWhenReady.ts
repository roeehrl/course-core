import { createRequire } from "node:module";
import { act, fireEvent } from "@testing-library/react";

// react-native-web's Pressable hands its new `disabled` and `onPress` to its press responder in a
// passive effect, after the render that shows them has committed. A render that does not come from
// an event (a request that settles, a timer) commits from React's scheduler, which then yields
// before running those effects as a separate task. Between the two, the page already shows the new
// button while its click handler still holds the old `disabled` and `onPress`. On a busy phone a
// learner's tap can land there too, so the app's own controls no longer use Pressable on web
// (components/LivePressable.tsx; tests/pressRightAfterRender.test.tsx). A test still presses right
// after `waitFor` and `findBy*`, which resolve on the DOM change; this lets React finish first.
//
// The scheduler is the one react-dom loads: both resolve it from this app's node_modules.
const scheduler = createRequire(import.meta.url)("scheduler") as {
  unstable_scheduleCallback(priority: number, callback: () => void): unknown;
  unstable_IdlePriority: number;
};

/** Resolves once React's scheduler has run every task queued before it: renders, and the passive
 * effects of renders that have already committed. */
export function reactIdle(): Promise<void> {
  return new Promise((resolve) => {
    // An idle task runs after every task of higher priority, including those queued later.
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => resolve());
  });
}

/** Lets React finish the work behind what the page shows, effects included, then presses `target`.
 * Use it for a press that follows `waitFor` or `findBy*`. Inside `act`, work that those effects start
 * is finished too. `press` defaults to a click. */
export async function pressWhenReady(target: Element, press: (target: Element) => unknown = fireEvent.click): Promise<void> {
  await act(async () => {
    await reactIdle();
  });
  if (!target.isConnected) throw new Error("pressWhenReady: the element left the page while React finished its work; query it again");
  await press(target);
}
