/** Runs with React's act environment off, so updates and effects are scheduled as in a browser
 * (inside act, React flushes them before a test's next step, which hides ordering races). */
export async function withoutAct<T>(work: () => Promise<T>): Promise<T> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const before = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await work();
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = before;
  }
}
/** Resolves in the DOM change that first shows the element, as a person acting at once would. */
export function firstSight<E extends Element>(
  find: () => E | null,
): Promise<E> {
  return new Promise((resolve) => {
    const present = find();
    if (present) return resolve(present);
    const observer = new MutationObserver(() => {
      const element = find();
      if (!element) return;
      observer.disconnect();
      resolve(element);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}
/** Acts with the act environment off, then lets pending effects and timers run. */
export const actNow = (step: () => void) =>
  withoutAct(async () => {
    step();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
