/**
 * Shift-window tests (bead rzo.4). All instants are fixed UTC datetimes —
 * the functions are pure, so expectations are exact.
 */

import { describe, expect, it } from 'vitest';
import { SHIFT_HOURS, SHIFT_START_HOUR, shiftWindow } from './shifts';

const ts = (iso: string): Date => new Date(iso);

describe('shift constants', () => {
  it('mirror the server shift-rollup defaults (api_history.py)', () => {
    expect(SHIFT_START_HOUR).toBe(6);
    expect(SHIFT_HOURS).toBe(12);
  });
});

describe('shiftWindow — current shift', () => {
  it('resolves the day shift when now is mid-day', () => {
    const win = shiftWindow(ts('2026-09-06T12:00:00Z'), 'current');
    expect(win.from.toISOString()).toBe('2026-09-06T06:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-06T12:00:00.000Z'); // still running → to = now
    expect(win.label).toBe('Current shift');
  });

  it('resolves tonight’s night shift when now is in the evening', () => {
    const win = shiftWindow(ts('2026-09-06T20:00:00Z'), 'current');
    expect(win.from.toISOString()).toBe('2026-09-06T18:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-06T20:00:00.000Z');
  });

  it('resolves yesterday’s night shift across midnight when now is pre-dawn', () => {
    const win = shiftWindow(ts('2026-09-06T03:00:00Z'), 'current');
    expect(win.from.toISOString()).toBe('2026-09-05T18:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-06T03:00:00.000Z');
  });

  it('treats exactly 06:00 as the day shift’s first instant', () => {
    const win = shiftWindow(ts('2026-09-06T06:00:00Z'), 'current');
    expect(win.from.toISOString()).toBe('2026-09-06T06:00:00.000Z');
  });

  it('treats exactly 18:00 as the night shift’s first instant', () => {
    const win = shiftWindow(ts('2026-09-06T18:00:00Z'), 'current');
    expect(win.from.toISOString()).toBe('2026-09-06T18:00:00.000Z');
  });
});

describe('shiftWindow — last night', () => {
  it('is the night that ended this morning, when now is past 06:00', () => {
    const win = shiftWindow(ts('2026-09-06T12:00:00Z'), 'lastNight');
    expect(win.from.toISOString()).toBe('2026-09-05T18:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-06T06:00:00.000Z');
    expect(win.label).toBe('Last night');
  });

  it('is the previous night when now is pre-dawn (tonight not over yet)', () => {
    const win = shiftWindow(ts('2026-09-06T03:00:00Z'), 'lastNight');
    expect(win.from.toISOString()).toBe('2026-09-04T18:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-05T06:00:00.000Z');
  });

  it('counts the night ending exactly now as completed (06:00 boundary)', () => {
    const win = shiftWindow(ts('2026-09-06T06:00:00Z'), 'lastNight');
    expect(win.from.toISOString()).toBe('2026-09-05T18:00:00.000Z');
    expect(win.to.toISOString()).toBe('2026-09-06T06:00:00.000Z');
  });
});
