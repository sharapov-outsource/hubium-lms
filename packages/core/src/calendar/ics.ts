import { fromZonedValue } from '@hubium/module-sdk/zoned';

// Reading iCalendar (RFC 5545) for calendar imports and subscriptions: a feed's events
// with their times as instants, repeating ones expanded into occurrences. Pure, so tests
// cover it without a database.
//
// Repeats: FREQ DAILY, WEEKLY, MONTHLY and YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (with
// ordinals such as 2TU or -1FR), BYMONTHDAY, BYMONTH, BYSETPOS and WKST, plus RDATE,
// EXDATE and changed or cancelled single occurrences (RECURRENCE-ID). Rarer rules (by the
// hour, minute or second, BYYEARDAY, BYWEEKNO) keep only their first occurrence and are
// counted in `simplified`.

export interface IcsEvent {
  /** Unique within the feed: the event's UID, and the occurrence for repeating ones. */
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date | null;
  /** All-day events start at UTC midnight of their date, as the calendar keeps them. */
  allDay: boolean;
}

export interface IcsResult {
  name: string;
  events: IcsEvent[];
  /** Repeating events whose rule is not supported: only the first occurrence is kept. */
  simplified: number;
  /** More events than the limit: the rest were left out. */
  truncated: boolean;
}

export interface IcsOptions {
  /** Zone for times without one (floating times) when the feed names none. */
  timeZone: string;
  /** Occurrences outside [from, to] are left out. */
  from: Date;
  to: Date;
  maxEvents?: number;
}

const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Outlook and Exchange name zones the Windows way.
const WINDOWS_ZONES: Record<string, string> = {
  UTC: 'UTC',
  'Russian Standard Time': 'Europe/Moscow',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Russia Time Zone 3': 'Europe/Samara',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Saratov Standard Time': 'Europe/Saratov',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Omsk Standard Time': 'Asia/Omsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Magadan Standard Time': 'Asia/Magadan',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'Belarus Standard Time': 'Europe/Minsk',
  'Central Asia Standard Time': 'Asia/Almaty',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
};

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

/** An IANA zone for a TZID (or the fallback when it is neither IANA nor a Windows name). */
export function resolveZone(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback;
  const z = tzid.replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, '');
  if (validZone(z)) return z;
  return WINDOWS_ZONES[z] ?? fallback;
}

// ── lines and components ─────────────────────────────────────────────────────

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  // the value starts at the first colon outside quotes
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) ?? [];
  const name = (parts.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(colon + 1) };
}

interface Component {
  type: string;
  props: Prop[];
  children: Component[];
}

function components(text: string): Component {
  const lines = text
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
  const root: Component = { type: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) continue;
    const top = stack.at(-1)!;
    if (p.name === 'BEGIN') {
      const c: Component = { type: p.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      if (stack.length > 1) stack.pop();
    } else top.props.push(p);
  }
  return root;
}

const unescapeText = (s: string) =>
  s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

// ── times ────────────────────────────────────────────────────────────────────

interface Wall {
  /** Days since 1970-01-01. */
  day: number;
  /** Seconds into the day. */
  sec: number;
}

interface Time {
  wall: Wall;
  allDay: boolean;
  /** 'UTC' for times ending in Z; otherwise the zone the wall time is in. */
  zone: string;
}

function parseTime(value: string, params: Record<string, string>, fallback: string): Time | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const day = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / DAY;
  if (Number.isNaN(day)) return null;
  if (m[4] === undefined || params.VALUE === 'DATE')
    return { wall: { day, sec: 0 }, allDay: true, zone: 'UTC' };
  const sec = +m[4]! * 3600 + +m[5]! * 60 + +(m[6] ?? 0);
  return {
    wall: { day, sec },
    allDay: false,
    zone: m[7] ? 'UTC' : resolveZone(params.TZID, fallback),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The instant (ms) a wall time means in a zone; all-day times are their UTC midnight. */
function instant(wall: Wall, zone: string, allDay = false): number {
  const base = wall.day * DAY;
  if (allDay || zone === 'UTC') return base + wall.sec * 1000;
  const d = new Date(base);
  const value = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(Math.floor(wall.sec / 3600))}:${pad(Math.floor(wall.sec / 60) % 60)}`;
  const iso = fromZonedValue(value, zone);
  return iso ? new Date(iso).getTime() + (wall.sec % 60) * 1000 : base + wall.sec * 1000;
}

/** Seconds of an iCalendar duration ("P1D", "PT1H30M", "P2W"); null when it is not one. */
export function durationSec(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m || /^[+-]?PT?$/.test(value.trim())) return null;
  const [, sign, w, d, h, mi, s] = m;
  const total =
    (+(w ?? 0) * 7 + +(d ?? 0)) * 86_400 + +(h ?? 0) * 3600 + +(mi ?? 0) * 60 + +(s ?? 0);
  return sign === '-' ? -total : total;
}

// ── repeat rules ─────────────────────────────────────────────────────────────

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: Time;
  byDay: { n: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
}

/** The rule, or null when it uses parts this reader does not expand. */
export function parseRule(value: string, fallback: string): Rule | null {
  const parts = Object.fromEntries(
    value
      .split(';')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k!.toUpperCase(), v!.toUpperCase()]),
  );
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  if (['BYHOUR', 'BYMINUTE', 'BYSECOND', 'BYYEARDAY', 'BYWEEKNO'].some((k) => k in parts))
    return null;
  const ints = (s: string | undefined) =>
    (s ?? '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n !== 0);
  const byDay: Rule['byDay'] = [];
  for (const d of (parts.BYDAY ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
    if (!m) return null;
    byDay.push({ n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2]!) });
  }
  const until = parts.UNTIL ? parseTime(parts.UNTIL, {}, fallback) : undefined;
  return {
    freq,
    interval: Math.max(1, Math.min(1000, Number(parts.INTERVAL ?? 1) || 1)),
    count: parts.COUNT ? Math.max(1, Number(parts.COUNT) || 1) : undefined,
    until: until ?? undefined,
    byDay,
    byMonthDay: ints(parts.BYMONTHDAY).filter((n) => Math.abs(n) <= 31),
    byMonth: ints(parts.BYMONTH).filter((n) => n >= 1 && n <= 12),
    bySetPos: ints(parts.BYSETPOS),
    wkst: Math.max(0, WEEKDAYS.indexOf(parts.WKST ?? 'MO')),
  };
}

const weekday = (day: number) => new Date(day * DAY).getUTCDay();
const ymd = (day: number) => {
  const d = new Date(day * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Days of `from..to` (inclusive) on a weekday, the nth of them (n < 0 from the end) or all. */
function weekdaysIn(from: number, to: number, wd: number, n: number): number[] {
  const first = from + ((wd - weekday(from) + 7) % 7);
  const all: number[] = [];
  for (let d = first; d <= to; d += 7) all.push(d);
  if (!n) return all;
  const pick = n > 0 ? all[n - 1] : all[all.length + n];
  return pick === undefined ? [] : [pick];
}

function monthDays(rule: Rule, y: number, m: number, startDom: number): number[] {
  const dim = daysInMonth(y, m);
  const first = dayOf(y, m, 1);
  if (rule.byMonthDay.length) {
    const days = rule.byMonthDay
      .map((x) => (x > 0 ? x : dim + 1 + x))
      .filter((x) => x >= 1 && x <= dim)
      .map((x) => first + x - 1);
    const wds = new Set(rule.byDay.map((b) => b.wd));
    return rule.byDay.length ? days.filter((d) => wds.has(weekday(d))) : days;
  }
  if (rule.byDay.length)
    return rule.byDay.flatMap((b) => weekdaysIn(first, first + dim - 1, b.wd, b.n));
  return startDom <= dim ? [first + startDom - 1] : [];
}

function setPos(rule: Rule, days: number[]): number[] {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (!rule.bySetPos.length) return sorted;
  return rule.bySetPos
    .map((p) => (p > 0 ? sorted[p - 1] : sorted[sorted.length + p]))
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);
}

/**
 * The days a rule repeats on from `start` (a day number), in order, at most `max` of them,
 * none after `lastDay`. Without COUNT the periods before `firstDay` are skipped.
 */
function ruleDays(
  rule: Rule,
  start: number,
  opts: { firstDay: number; lastDay: number; max: number },
): number[] {
  const out: number[] = [];
  const s = ymd(start);
  const months = new Set(rule.byMonth);
  const inMonths = (d: number) => !months.size || months.has(ymd(d).m);
  const weekStart = start - ((weekday(start) - rule.wkst + 7) % 7);
  const skip = (periods: number) =>
    rule.count === undefined ? Math.max(0, Math.floor(periods / rule.interval) - 1) : 0;
  let k =
    rule.freq === 'DAILY'
      ? skip(opts.firstDay - start)
      : rule.freq === 'WEEKLY'
        ? skip(Math.floor((opts.firstDay - weekStart) / 7))
        : rule.freq === 'MONTHLY'
          ? skip(ymd(opts.firstDay).y * 12 + ymd(opts.firstDay).m - (s.y * 12 + s.m))
          : skip(ymd(opts.firstDay).y - s.y);
  for (let guard = 0; guard < 20_000 && out.length < opts.max; guard++, k++) {
    let days: number[];
    let periodStart: number;
    if (rule.freq === 'DAILY') {
      periodStart = start + k * rule.interval;
      const wds = new Set(rule.byDay.map((b) => b.wd));
      const dim = daysInMonth(ymd(periodStart).y, ymd(periodStart).m);
      const dom = ymd(periodStart).d;
      const ok =
        inMonths(periodStart) &&
        (!wds.size || wds.has(weekday(periodStart))) &&
        (!rule.byMonthDay.length || rule.byMonthDay.some((x) => (x > 0 ? x : dim + 1 + x) === dom));
      days = ok ? [periodStart] : [];
    } else if (rule.freq === 'WEEKLY') {
      periodStart = weekStart + 7 * rule.interval * k;
      const wds = rule.byDay.length ? rule.byDay.map((b) => b.wd) : [weekday(start)];
      days = setPos(rule, wds.map((w) => periodStart + ((w - rule.wkst + 7) % 7)).filter(inMonths));
    } else if (rule.freq === 'MONTHLY') {
      const mi = s.y * 12 + (s.m - 1) + k * rule.interval;
      const y = Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      periodStart = dayOf(y, m, 1);
      days = months.size && !months.has(m) ? [] : setPos(rule, monthDays(rule, y, m, s.d));
    } else {
      const y = s.y + k * rule.interval;
      periodStart = dayOf(y, 1, 1);
      if (rule.byDay.length && !rule.byMonth.length && !rule.byMonthDay.length) {
        const last = dayOf(y, 12, 31);
        days = setPos(
          rule,
          rule.byDay.flatMap((b) => weekdaysIn(periodStart, last, b.wd, b.n)),
        );
      } else {
        const ms = rule.byMonth.length ? rule.byMonth : [s.m];
        days = setPos(
          rule,
          ms.flatMap((m) =>
            rule.byMonthDay.length || rule.byDay.length
              ? monthDays(rule, y, m, s.d)
              : s.d <= daysInMonth(y, m)
                ? [dayOf(y, m, s.d)]
                : [],
          ),
        );
      }
    }
    if (periodStart > opts.lastDay) break;
    for (const d of days) if (d >= start && d <= opts.lastDay) out.push(d);
  }
  return out.slice(0, opts.max);
}

// ── events ───────────────────────────────────────────────────────────────────

function textOf(c: Component, name: string): string {
  const p = c.props.find((x) => x.name === name);
  return p ? unescapeText(p.value) : '';
}

/** Times of RDATE / EXDATE properties (each may hold several). */
function timesOf(c: Component, name: string, fallback: string): Time[] {
  return c.props
    .filter((p) => p.name === name)
    .flatMap((p) =>
      p.value
        .split(',')
        .map((v) => parseTime(v.split('/')[0]!, p.params, fallback))
        .filter((t): t is Time => !!t),
    );
}

/** Reads a feed. Throws when the text is not an iCalendar at all. */
export function parseIcs(text: string, opts: IcsOptions): IcsResult {
  const root = components(text);
  const cal = root.children.find((c) => c.type === 'VCALENDAR');
  if (!cal) throw new Error('Not an iCalendar file');
  const feedZone = textOf(cal, 'X-WR-TIMEZONE');
  const fallback = resolveZone(feedZone || undefined, opts.timeZone);
  const max = opts.maxEvents ?? 5000;
  const from = opts.from.getTime();
  const to = opts.to.getTime();
  const out: IcsEvent[] = [];
  let simplified = 0;
  let truncated = false;

  const vevents = cal.children.filter((c) => c.type === 'VEVENT');
  // changed or cancelled occurrences, by UID and the occurrence they replace
  const overrides = new Map<string, Map<number, Component>>();
  for (const v of vevents) {
    const rid = v.props.find((p) => p.name === 'RECURRENCE-ID');
    if (!rid) continue;
    const t = parseTime(rid.value, rid.params, fallback);
    if (!t) continue;
    const uid = textOf(v, 'UID');
    const map = overrides.get(uid) ?? new Map<number, Component>();
    map.set(instant(t.wall, t.zone, t.allDay), v);
    overrides.set(uid, map);
  }

  const push = (e: IcsEvent) => {
    if (out.length >= max) {
      truncated = true;
      return;
    }
    out.push(e);
  };

  /** The event as one occurrence: its times from its own DTSTART/DTEND/DURATION. */
  const single = (v: Component, uid: string, shiftTo?: number) => {
    const sp = v.props.find((p) => p.name === 'DTSTART');
    const start = sp ? parseTime(sp.value, sp.params, fallback) : null;
    if (!start) return null;
    const startMs = instant(start.wall, start.zone, start.allDay);
    const ep = v.props.find((p) => p.name === 'DTEND');
    const end = ep ? parseTime(ep.value, ep.params, fallback) : null;
    const dur = durationSec(textOf(v, 'DURATION'));
    let endMs = end ? instant(end.wall, end.zone, end.allDay) : dur ? startMs + dur * 1000 : null;
    // an all-day event's end is exclusive: a one-day event has none
    if (start.allDay && endMs !== null) endMs = endMs - DAY > startMs ? endMs - DAY : null;
    const s = shiftTo ?? startMs;
    return {
      uid,
      summary: textOf(v, 'SUMMARY').trim().slice(0, 255) || '—',
      description: textOf(v, 'DESCRIPTION').slice(0, 5000),
      location: textOf(v, 'LOCATION').slice(0, 255),
      start: new Date(s),
      end: endMs === null ? null : new Date(s + (endMs - startMs)),
      allDay: start.allDay,
    } satisfies IcsEvent;
  };

  const inWindow = (e: IcsEvent) => e.start.getTime() <= to && (e.end ?? e.start).getTime() >= from;

  for (const v of vevents) {
    if (v.props.some((p) => p.name === 'RECURRENCE-ID')) continue;
    if (textOf(v, 'STATUS').toUpperCase() === 'CANCELLED') continue;
    const uid = textOf(v, 'UID') || `${textOf(v, 'SUMMARY')}@${textOf(v, 'DTSTART')}`;
    const sp = v.props.find((p) => p.name === 'DTSTART');
    const start = sp ? parseTime(sp.value, sp.params, fallback) : null;
    if (!start) continue;
    const rruleProp = v.props.find((p) => p.name === 'RRULE');
    const rdates = timesOf(v, 'RDATE', fallback);
    if (!rruleProp && !rdates.length) {
      const e = single(v, uid);
      if (e && inWindow(e)) push(e);
      continue;
    }
    const rule = rruleProp ? parseRule(rruleProp.value, fallback) : null;
    if (rruleProp && !rule) simplified++;
    // occurrences as instants, from the rule in the event's own wall time
    const ruled = new Set<number>([instant(start.wall, start.zone, start.allDay)]);
    if (rule) {
      const untilMs = rule.until
        ? rule.until.allDay && !start.allDay
          ? instant({ day: rule.until.wall.day, sec: 86_399 }, start.zone)
          : instant(rule.until.wall, rule.until.zone, rule.until.allDay)
        : Number.POSITIVE_INFINITY;
      const days = ruleDays(rule, start.wall.day, {
        firstDay: Math.floor(from / DAY) - 2,
        lastDay: Math.ceil(Math.min(to, untilMs) / DAY) + 1,
        max: rule.count ?? 5000,
      });
      for (const d of days) {
        const t = instant({ day: d, sec: start.wall.sec }, start.zone, start.allDay);
        if (t <= untilMs) ruled.add(t);
      }
    }
    // COUNT limits the rule's occurrences; RDATE adds to them (RFC 5545, 3.8.5.2)
    const counted = [...ruled].sort((a, b) => a - b);
    const occurrences = new Set(rule?.count ? counted.slice(0, rule.count) : counted);
    for (const r of rdates) occurrences.add(instant(r.wall, r.zone, r.allDay));
    const kept = [...occurrences].sort((a, b) => a - b);
    const excluded = new Set(
      timesOf(v, 'EXDATE', fallback).map((x) => instant(x.wall, x.zone, x.allDay)),
    );
    const changed = overrides.get(uid);
    for (const t of kept) {
      if (excluded.has(t)) continue;
      const key = `${uid}/${new Date(t).toISOString()}`;
      const over = changed?.get(t);
      if (over && textOf(over, 'STATUS').toUpperCase() === 'CANCELLED') continue;
      const e = over ? single(over, key) : single(v, key, t);
      if (e && inWindow(e)) push(e);
      if (truncated) break;
    }
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    name: textOf(cal, 'X-WR-CALNAME').trim().slice(0, 255),
    events: out,
    simplified,
    truncated,
  };
}
