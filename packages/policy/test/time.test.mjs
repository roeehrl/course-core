import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, resolveCalendarWindow, createPolicyState, resolveConstraints } from '../dist/index.js';
import { errorCode, initial } from './helpers.mjs';

test('calendar days across spring/fall DST preserve wall time and are 23/25 hours', () => {
  assert.equal(addCalendarDays({ at: '2024-03-09T17:00:00Z', calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject' }), '2024-03-10T16:00:00Z');
  assert.equal(addCalendarDays({ at: '2024-11-02T16:00:00Z', calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject' }), '2024-11-03T17:00:00Z');
});

test('nonexistent local endpoint requires explicit resolution and supports earlier/later', () => {
  const args = { at: '2024-03-09T07:30:00Z', calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject' };
  assert.throws(() => addCalendarDays(args), errorCode('INVALID_CALENDAR_TIME'));
  assert.equal(addCalendarDays({ ...args, disambiguation: 'earlier' }), '2024-03-10T06:30:00Z');
  assert.equal(addCalendarDays({ ...args, disambiguation: 'later' }), '2024-03-10T07:30:00Z');
  assert.equal(addCalendarDays({ ...args, disambiguation: 'compatible' }), '2024-03-10T07:30:00Z');
});

test('repeated local endpoint resolves each fold explicitly; zero days preserves a known instant', () => {
  const args = { at: '2024-11-02T05:30:00Z', calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject' };
  assert.throws(() => addCalendarDays(args), errorCode('INVALID_CALENDAR_TIME'));
  assert.equal(addCalendarDays({ ...args, disambiguation: 'earlier' }), '2024-11-03T05:30:00Z');
  assert.equal(addCalendarDays({ ...args, disambiguation: 'later' }), '2024-11-03T06:30:00Z');
  assert.equal(addCalendarDays({ ...args, at: '2024-11-03T06:30:00Z', calendarDays: 0 }), '2024-11-03T06:30:00Z');
});

test('half-hour DST, leap-day and year boundaries use actual calendar rules', () => {
  assert.equal(addCalendarDays({ at: '2024-10-05T01:30:00Z', calendarDays: 1, timeZone: 'Australia/Lord_Howe', disambiguation: 'reject' }), '2024-10-06T01:00:00Z');
  assert.equal(addCalendarDays({ at: '2024-02-28T12:00:00Z', calendarDays: 1, timeZone: 'UTC', disambiguation: 'reject' }), '2024-02-29T12:00:00Z');
  assert.equal(addCalendarDays({ at: '2024-12-31T12:00:00Z', calendarDays: 1, timeZone: 'UTC', disambiguation: 'reject' }), '2025-01-01T12:00:00Z');
});

test('unknown zones, fixed offsets, missing offset, impossible instants and invalid counts fail closed', () => {
  const valid = { at: '2024-03-09T17:00:00Z', calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject' };
  for (const patch of [
    { timeZone: 'Unknown/Zone' }, { timeZone: '+02:00' }, { at: '2024-02-31T00:00:00Z' }, { at: '2024-03-09T17:00:00' },
    { calendarDays: -1 }, { calendarDays: 1.5 }, { calendarDays: Infinity }, { calendarDays: NaN }, { calendarDays: Number.MAX_SAFE_INTEGER + 1 },
    { disambiguation: 'guess' }, { calendarDays: '1' }, { unexpected: true },
  ]) assert.throws(() => addCalendarDays({ ...valid, ...patch }), errorCode('INVALID_INPUT'));
  assert.throws(() => addCalendarDays({ at: valid.at, calendarDays: 1, timeZone: valid.timeZone }), errorCode('INVALID_INPUT'));
  assert.throws(() => addCalendarDays({ ...valid, calendarDays: Number.MAX_SAFE_INTEGER }), errorCode('INVALID_CALENDAR_TIME'));
});

test('persisted calendar preview is validated at creation and unaffected by device zone changes', () => {
  const window = resolveCalendarWindow({ anchorId: 'anchor', anchor: 'enrollment_started', anchorInstant: '2024-03-09T17:00:00Z',
    calendarDays: 1, timeZone: 'America/New_York', disambiguation: 'reject', pauseRule: 'approved_only' });
  const input = initial(); input.scopes[0].window = window;
  const state = createPolicyState(input);
  const before = resolveConstraints(state, 'chapter');
  const oldZone = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Auckland';
    assert.deepEqual(resolveConstraints(JSON.parse(JSON.stringify(state)), 'chapter'), before);
    assert.equal(before.effectiveDeadline, '2024-03-10T16:00:00Z');
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
  input.scopes[0].window.resolvedDeadline = '2024-03-10T17:00:00Z';
  assert.throws(() => createPolicyState(input), errorCode('INVALID_CALENDAR_TIME'));
});

test('one anchor ID cannot silently refer to different events in different windows', () => {
  const rule = { anchorId: 'shared-anchor', anchor: 'enrollment_started', anchorInstant: '2024-03-09T17:00:00Z', calendarDays: 1,
    timeZone: 'America/New_York', disambiguation: 'reject', pauseRule: 'never' };
  const input = initial();
  input.scopes[0].window = resolveCalendarWindow(rule);
  input.scopes[1].window = resolveCalendarWindow({ ...rule, anchorInstant: '2024-03-10T17:00:00Z' });
  assert.throws(() => createPolicyState(input), errorCode('INVALID_INPUT'));
});
