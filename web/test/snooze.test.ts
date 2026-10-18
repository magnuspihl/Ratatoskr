import { describe, expect, it } from 'vitest';
import { removesFromList } from '../src/swipe';
import { updateSticky } from '../src/sticky';
import { defaultCustomTime, formatSnoozeTime, fromLocalInput, snoozePresets, toLocalInput } from '../src/snooze';

// All in local time: October 2026, the 12th is a Monday and the 18th a Sunday.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const presets = (now: Date) => Object.fromEntries(snoozePresets(now).map((p) => [p.id, p.until.getTime()]));

describe('snooze quick choices', () => {
  it('offers later today, tomorrow, this weekend and next week on a weekday morning', () => {
    expect(presets(local(13, 9, 20))).toEqual({
      later: local(13, 13).getTime(),
      tomorrow: local(14, 8).getTime(),
      weekend: local(17, 8).getTime(),
      nextWeek: local(19, 8).getTime(),
    });
  });

  it('rounds "later today" up to a full hour and leaves an exact hour as it is', () => {
    expect(presets(local(13, 10, 0)).later).toBe(local(13, 13).getTime());
    expect(presets(local(13, 10, 1)).later).toBe(local(13, 14).getTime());
  });

  it('drops "later today" in the evening', () => {
    expect(presets(local(13, 17, 30)).later).toBeUndefined();
    expect(presets(local(13, 23, 30)).later).toBeUndefined();
  });

  it('offers "this weekend" only from Monday to Thursday', () => {
    expect(presets(local(15, 9)).weekend).toBe(local(17, 8).getTime());
    for (const day of [16, 17, 18]) expect(presets(local(day, 9)).weekend).toBeUndefined();
  });

  it('means the coming Monday by "next week", and does not repeat it on a Sunday', () => {
    expect(presets(local(12, 9)).nextWeek).toBe(local(19, 8).getTime());
    expect(presets(local(17, 9)).nextWeek).toBe(local(19, 8).getTime());
    const sunday = snoozePresets(local(18, 9));
    expect(sunday.map((p) => p.id)).toEqual(['later', 'tomorrow']);
    expect(sunday[1]!.until.getTime()).toBe(local(19, 8).getTime());
  });

  it('only ever offers times in the future', () => {
    for (let day = 12; day <= 18; day++) {
      for (const hour of [0, 7, 8, 12, 20, 23]) {
        const now = local(day, hour, 59);
        for (const p of snoozePresets(now)) expect(p.until.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });
});

describe('picking a date and time', () => {
  it('reads and writes the date-time picker value in local time', () => {
    expect(toLocalInput(local(5, 7, 3))).toBe('2026-10-05T07:03');
    expect(fromLocalInput('2026-10-05T07:03')?.getTime()).toBe(local(5, 7, 3).getTime());
    expect(defaultCustomTime(local(13, 22))).toEqual(local(14, 8));
  });

  it('rejects empty, malformed and impossible dates', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(fromLocalInput('2026-02-30T08:00')).toBeNull();
    expect(fromLocalInput('2026-10-05T25:00')).toBeNull();
  });
});

describe('showing when a snoozed message returns', () => {
  const now = local(13, 9);
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  it('says today, tomorrow, the weekday within a week, or the date', () => {
    expect(formatSnoozeTime(local(13, 18), now)).toBe(`Today ${time(local(13, 18))}`);
    expect(formatSnoozeTime(local(14, 8).toISOString(), now)).toBe(`Tomorrow ${time(local(14, 8))}`);
    expect(formatSnoozeTime(local(17, 8), now)).toMatch(new RegExp(`^\\S+ ${time(local(17, 8))}$`));
    expect(formatSnoozeTime(local(30, 8), now)).toContain('30');
    expect(formatSnoozeTime(new Date(2027, 0, 4, 8), now)).toContain('2027');
  });
});

describe('snoozing in the message list', () => {
  it('takes snoozed and unsnoozed messages out of the list they were in', () => {
    expect(removesFromList({ type: 'snooze', until: '2026-10-14T08:00:00Z' })).toBe(true);
    expect(removesFromList({ type: 'unsnooze' })).toBe(true);
  });

  it('does not keep a snoozed message on screen in the unread-only view', () => {
    expect(updateSticky(new Set(['a|1']), ['a|1'], { type: 'snooze' }).size).toBe(0);
  });
});
