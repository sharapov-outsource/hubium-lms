// Wall-clock date and time ("YYYY-MM-DDTHH:mm", as a datetime-local input holds it) in a
// named time zone, to and from instants. Pickers show times in the user's profile zone,
// the one the server formats dates in, not in whatever zone the browser happens to be in.

const pad = (n: number) => String(n).padStart(2, '0');

function wallParts(t: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(t);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    y: get('year'),
    m: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second'),
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(t: number, timeZone: string) {
  const w = wallParts(t, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/** The wall-clock value of an instant in the zone; '' for no or a bad instant. */
export function toZonedValue(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const w = wallParts(t, timeZone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

const DAY = 86_400_000;

/**
 * The instant a wall-clock value means in the zone, as ISO; '' for an empty or bad value.
 * As Temporal's "compatible" choice: a time repeated by a clock change is the first of the
 * two, a time skipped by one lands as far after the change as it was meant after the start.
 */
export function fromZonedValue(value: string | null | undefined, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value ?? '');
  if (!m) return '';
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  // the zone's offsets a day before and after: they differ only around a clock change
  const before = guess - offsetAt(guess - DAY, timeZone);
  const after = guess - offsetAt(guess + DAY, timeZone);
  const fits = [before, after]
    .filter((t) => toZonedValue(new Date(t).toISOString(), timeZone) === wall)
    .sort((a, b) => a - b);
  return new Date(fits[0] ?? before).toISOString();
}
