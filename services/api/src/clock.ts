/** The server's notion of "now" for time-based learning decisions (retention
 * due-ness, wake-up boundaries, cap closure). Production always uses the system
 * clock. A different clock can only be passed to createServer by trusted code,
 * and createServer refuses one unless NODE_ENV is exactly "test": there is no
 * environment variable, header or route that changes the time. */
export interface Clock { now(): Date }

export const systemClock: Clock = Object.freeze({ now: () => new Date() });

/** Refuses a non-system clock outside the test environment. */
export function serverClock(clock: Clock | undefined, environment: string | undefined = process.env.NODE_ENV): Clock {
  if (!clock || clock === systemClock) return systemClock;
  if (environment !== 'test') throw new Error('A test clock can only be installed when NODE_ENV=test.');
  return clock;
}

/** A controllable clock for tests: real time shifted by a settable offset. */
export function offsetClock(offsetMs = 0) {
  let offset = offsetMs;
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms: number) { offset += ms; },
    set(ms: number) { offset = ms; },
  };
}
