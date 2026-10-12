import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { calendarRuleSchema, count, disambiguation, instant, parse, PolicyError, timeZone } from './contracts.js';

export function compareInstants(a: string, b: string): number {
  return Temporal.Instant.compare(parse(instant, a), parse(instant, b));
}

export function canonicalInstant(value: string): string {
  return Temporal.Instant.from(parse(instant, value)).toString();
}

const addSchema = z.strictObject({ at: instant, calendarDays: count, timeZone, disambiguation });

/** Calendar arithmetic retains local wall time; disambiguation is never implicit. */
export function addCalendarDays(input: z.input<typeof addSchema>): string {
  const args = parse(addSchema, input);
  if (args.calendarDays === 0) return canonicalInstant(args.at);
  try {
    const start = Temporal.Instant.from(args.at).toZonedDateTimeISO(args.timeZone);
    const local = start.toPlainDateTime().add({ days: args.calendarDays });
    return local.toZonedDateTime(args.timeZone, { disambiguation: args.disambiguation }).toInstant().toString();
  } catch {
    throw new PolicyError('INVALID_CALENDAR_TIME', 'Calendar endpoint is ambiguous, nonexistent, or out of range; preview an explicit resolution');
  }
}

/** Persist this accepted preview. Resolvers subsequently read its stored instant. */
export function resolveCalendarWindow(input: z.input<typeof calendarRuleSchema>) {
  const rule = parse(calendarRuleSchema, input);
  return {
    ...rule,
    anchorInstant: canonicalInstant(rule.anchorInstant),
    resolvedDeadline: addCalendarDays({ at: rule.anchorInstant, ...{
      calendarDays: rule.calendarDays, timeZone: rule.timeZone, disambiguation: rule.disambiguation,
    } }),
  };
}

export function hoursBetween(a: string, b: string): number {
  return Number(Temporal.Instant.from(b).epochNanoseconds - Temporal.Instant.from(a).epochNanoseconds) / 3_600_000_000_000;
}
