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

const calendarPreviewSchema = z.strictObject({
  timeZone, calendarDays: count, disambiguation, from: instant, until: instant,
  /** For an absolute deadline: its stored instant. Extensions of 1..maxExtensionDays are previewed. */
  absoluteAt: instant.optional(), maxExtensionDays: count.default(0),
});
export interface CalendarTransitionPreview {
  transitionAt: string; kind: 'gap' | 'overlap'; offsetBefore: string; offsetAfter: string;
  /** Local wall-clock range on the transition date that is skipped (gap) or repeated (overlap). */
  localDate: string; localStart: string; localEnd: string;
  /** For a relative window: anchors in this local range land in the gap/overlap. */
  affectedAnchorDate: string | null;
  example: { anchorAt: string; resolved: string | null } | null;
  resolution: 'rejected' | 'earlier' | 'later';
}
/** Publish-time preview of daylight-saving effects for a calendar rule. Lists each offset
 * transition in [from, until], which local times it skips or repeats, and how the declared
 * disambiguation resolves them; `reject` means such enrollments or extensions are refused. */
export function previewCalendarRule(input: z.input<typeof calendarPreviewSchema>) {
  const args = parse(calendarPreviewSchema, input);
  const transitions: CalendarTransitionPreview[] = [];
  const end = Temporal.Instant.from(args.until);
  let cursor: Temporal.ZonedDateTime | null = Temporal.Instant.from(args.from).toZonedDateTimeISO(args.timeZone);
  for (let guard = 0; guard < 64; guard += 1) {
    cursor = cursor.getTimeZoneTransition('next');
    if (!cursor || Temporal.Instant.compare(cursor.toInstant(), end) > 0) break;
    const before = cursor.subtract({ nanoseconds: 1 }), after = cursor;
    const delta = after.offsetNanoseconds - before.offsetNanoseconds;
    if (delta === 0) continue;
    const kind = delta > 0 ? 'gap' as const : 'overlap' as const;
    // Local wall-clock range that is skipped (gap) or occurs twice (overlap).
    const startWall = kind === 'gap' ? after.toPlainDateTime().subtract({ nanoseconds: delta }) : after.toPlainDateTime();
    const endWall = startWall.add({ nanoseconds: Math.abs(delta) });
    const resolution = args.disambiguation === 'reject' ? 'rejected' as const
      : args.disambiguation === 'earlier' ? 'earlier' as const
        : args.disambiguation === 'later' ? 'later' as const
          : kind === 'gap' ? 'later' as const : 'earlier' as const;
    const probeWall = startWall.add({ nanoseconds: Math.floor(Math.abs(delta) / 2) });
    let example: CalendarTransitionPreview['example'] = null, affectedAnchorDate: string | null = null;
    if (args.absoluteAt === undefined && args.calendarDays > 0) {
      const anchorWall = probeWall.subtract({ days: args.calendarDays });
      affectedAnchorDate = anchorWall.toPlainDate().toString();
      const anchorAt = anchorWall.toZonedDateTime(args.timeZone, { disambiguation: 'compatible' }).toInstant().toString();
      example = { anchorAt, resolved: resolveExample(anchorAt, args.calendarDays, args.timeZone, args.disambiguation) };
    }
    transitions.push({ transitionAt: cursor.toInstant().toString(), kind, offsetBefore: before.offset, offsetAfter: after.offset,
      localDate: startWall.toPlainDate().toString(), localStart: startWall.toPlainTime().toString(), localEnd: endWall.toPlainTime().toString(),
      affectedAnchorDate, example, resolution });
  }
  const extensionEndpoints: { calendarDays: number; resolved: string | null }[] = [];
  if (args.absoluteAt !== undefined) {
    for (let days = 1; days <= Math.min(args.maxExtensionDays, 366); days += 1) {
      extensionEndpoints.push({ calendarDays: days, resolved: resolveExample(args.absoluteAt, days, args.timeZone, args.disambiguation) });
    }
  }
  const rejected = extensionEndpoints.filter(e => e.resolved === null).map(e => e.calendarDays);
  return { timeZone: args.timeZone, disambiguation: args.disambiguation, calendarDays: args.calendarDays, transitions,
    extensionEndpoints, rejectedExtensionDays: rejected,
    rejectsSomeStarts: args.disambiguation === 'reject' && transitions.length > 0 && args.absoluteAt === undefined };
}
function resolveExample(at: string, calendarDays: number, zone: string, disambiguation: 'reject' | 'earlier' | 'later' | 'compatible'): string | null {
  try { return addCalendarDays({ at, calendarDays, timeZone: zone, disambiguation }); } catch { return null; }
}
