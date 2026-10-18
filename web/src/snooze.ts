/** Snooze times: pure date logic in the user's local time zone, kept free of DOM access so it can be unit tested. */

export interface SnoozePreset {
  id: 'later' | 'tomorrow' | 'weekend' | 'nextWeek';
  label: string;
  until: Date;
}

/** Hour of the morning used by "Tomorrow", "This weekend" and "Next week". */
export const MORNING_HOUR = 8;

function at(day: Date, hour: number, minute = 0): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function addDays(day: Date, n: number): Date {
  const d = new Date(day);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * The quick choices in the snooze menu:
 * - Later today: three hours from now, rounded up to the next full hour; only while that is
 *   still today, before 21:00;
 * - Tomorrow morning;
 * - This weekend: Saturday morning, offered Monday to Thursday;
 * - Next week: Monday morning.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const out: SnoozePreset[] = [];
  const later = new Date(now.getTime() + 3 * 3600_000);
  if (later.getMinutes() || later.getSeconds() || later.getMilliseconds()) later.setHours(later.getHours() + 1, 0, 0, 0);
  if (later.toDateString() === now.toDateString() && later.getHours() < 21) out.push({ id: 'later', label: 'Later today', until: later });
  out.push({ id: 'tomorrow', label: 'Tomorrow', until: at(addDays(now, 1), MORNING_HOUR) });
  const dow = now.getDay(); // 0 = Sunday
  if (dow >= 1 && dow <= 4) out.push({ id: 'weekend', label: 'This weekend', until: at(addDays(now, 6 - dow), MORNING_HOUR) });
  const monday = at(addDays(now, ((8 - dow) % 7) || 7), MORNING_HOUR);
  // On Sundays "Tomorrow" already is Monday morning.
  if (!out.some((p) => p.until.getTime() === monday.getTime())) out.push({ id: 'nextWeek', label: 'Next week', until: monday });
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local"> (local time, minutes). */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse an <input type="datetime-local"> value as local time; null if it isn't one. */
export function fromLocalInput(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi);
  // Reject impossible dates (Feb 30) that Date would silently roll over.
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h ? date : null;
}

/** A default for the custom picker: tomorrow morning. */
export const defaultCustomTime = (now: Date) => at(addDays(now, 1), MORNING_HOUR);

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Short wake-up time: "Today 18:00", "Tomorrow 08:00", "Sat 08:00" (this week), "Oct 25, 08:00". */
export function formatSnoozeTime(until: Date | string, now = new Date()): string {
  const d = typeof until === 'string' ? new Date(until) : until;
  if (d.toDateString() === now.toDateString()) return `Today ${time(d)}`;
  if (d.toDateString() === addDays(now, 1).toDateString()) return `Tomorrow ${time(d)}`;
  if (d > now && d.getTime() - now.getTime() < 6 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time(d)}`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) };
  return `${d.toLocaleDateString(undefined, opts)}, ${time(d)}`;
}
