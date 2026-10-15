import { describe, expect, it } from 'vitest';
import { durationSec, parseIcs, resolveZone } from './ics.ts';

const wrap = (body: string, head = '') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${head}${body}END:VCALENDAR\r\n`;
const vevent = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`;

const opts = {
  timeZone: 'UTC',
  from: new Date('2026-01-01T00:00:00Z'),
  to: new Date('2027-12-31T00:00:00Z'),
};
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('iCalendar', () => {
  it('reads events: folded lines, escapes, zones, all-day and durations', () => {
    const r = parseIcs(
      wrap(
        vevent([
          'UID:a@x',
          'DTSTART:20261005T090000Z',
          'DTEND:20261005T103000Z',
          'SUMMARY:Лекция\\, часть 1',
          'DESCRIPTION:Первая строка\\nвторая стр',
          ' ока',
          'LOCATION:Ауд. 101',
        ]) +
          vevent(['UID:b@x', 'DTSTART;TZID=Europe/Moscow:20261006T120000', 'DURATION:PT45M']) +
          vevent(['UID:c@x', 'DTSTART;TZID="Russian Standard Time":20261007T120000']) +
          vevent(['UID:d@x', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261011']) +
          vevent(['UID:e@x', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261015']) +
          vevent(['UID:f@x', 'DTSTART:20261008T100000', 'SUMMARY:По часам ленты']),
        'X-WR-CALNAME:Расписание\r\nX-WR-TIMEZONE:Asia/Yekaterinburg\r\n',
      ),
      opts,
    );
    expect(r.name).toBe('Расписание');
    const by = Object.fromEntries(r.events.map((e) => [e.uid, e]));
    expect(by['a@x']).toMatchObject({
      summary: 'Лекция, часть 1',
      description: 'Первая строка\nвторая строка',
      location: 'Ауд. 101',
      allDay: false,
    });
    expect(iso(by['a@x']!.end)).toBe('2026-10-05T10:30:00.000Z');
    // Moscow is UTC+3; a Windows zone name means the same zone
    expect(iso(by['b@x']!.start)).toBe('2026-10-06T09:00:00.000Z');
    expect(iso(by['b@x']!.end)).toBe('2026-10-06T09:45:00.000Z');
    expect(iso(by['c@x']!.start)).toBe('2026-10-07T09:00:00.000Z');
    // all-day: UTC midnight; one day has no end, three days end on the last one
    expect(by['d@x']).toMatchObject({ allDay: true, end: null });
    expect(iso(by['d@x']!.start)).toBe('2026-10-10T00:00:00.000Z');
    expect(iso(by['e@x']!.end)).toBe('2026-10-14T00:00:00.000Z');
    // a time without a zone is in the feed's zone (UTC+5)
    expect(iso(by['f@x']!.start)).toBe('2026-10-08T05:00:00.000Z');
    expect(() => parseIcs('hello', opts)).toThrow(/iCalendar/);
  });

  it('expands repeating events by their rules', () => {
    const days = (rule: string, start = '20261005T100000Z', extra: string[] = []) =>
      parseIcs(
        wrap(vevent(['UID:r', `DTSTART:${start}`, `RRULE:${rule}`, ...extra])),
        opts,
      ).events.map((e) => iso(e.start)!.slice(0, 10));
    // 2026-10-05 is a Monday
    expect(days('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')).toEqual([
      '2026-10-05',
      '2026-10-07',
      '2026-10-12',
      '2026-10-14',
    ]);
    expect(days('FREQ=DAILY;INTERVAL=2;UNTIL=20261011T235959Z')).toEqual([
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
      '2026-10-11',
    ]);
    // the second Tuesday, and the last Friday, of each month
    expect(days('FREQ=MONTHLY;BYDAY=2TU;COUNT=3', '20261013T100000Z')).toEqual([
      '2026-10-13',
      '2026-11-10',
      '2026-12-08',
    ]);
    expect(days('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2', '20261030T100000Z')).toEqual([
      '2026-10-30',
      '2026-11-27',
    ]);
    // the 31st only in months that have one
    expect(days('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3', '20261031T100000Z')).toEqual([
      '2026-10-31',
      '2026-12-31',
      '2027-01-31',
    ]);
    // the last working day of the month
    expect(
      days('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2', '20261030T100000Z'),
    ).toEqual(['2026-10-30', '2026-11-30']);
    expect(days('FREQ=YEARLY;COUNT=2', '20261005T100000Z')).toEqual(['2026-10-05', '2027-10-05']);
    // one occurrence left out, one moved, one cancelled
    const r = parseIcs(
      wrap(
        vevent([
          'UID:w',
          'DTSTART:20261005T100000Z',
          'RRULE:FREQ=WEEKLY;COUNT=4',
          'EXDATE:20261012T100000Z',
        ]) +
          vevent([
            'UID:w',
            'RECURRENCE-ID:20261019T100000Z',
            'DTSTART:20261020T150000Z',
            'SUMMARY:Перенесено',
          ]) +
          vevent(['UID:w', 'RECURRENCE-ID:20261026T100000Z', 'STATUS:CANCELLED']),
      ),
      opts,
    );
    expect(r.events.map((e) => [iso(e.start), e.summary])).toEqual([
      ['2026-10-05T10:00:00.000Z', '—'],
      ['2026-10-20T15:00:00.000Z', 'Перенесено'],
    ]);
    expect(new Set(r.events.map((e) => e.uid)).size).toBe(2);
  });

  it('keeps the wall time across a clock change, and only the dates in the window', () => {
    const r = parseIcs(
      wrap(
        vevent([
          'UID:dst',
          'DTSTART;TZID=Europe/Berlin:20261019T100000',
          'RRULE:FREQ=WEEKLY;COUNT=3',
        ]) +
          // daily since 2010 with no end: only the window's days
          vevent(['UID:old', 'DTSTART:20100101T080000Z', 'RRULE:FREQ=DAILY']),
      ),
      { ...opts, from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-02T23:00:00Z') },
    );
    expect(r.events.filter((e) => e.uid.startsWith('dst')).map((e) => iso(e.start))).toEqual([
      '2026-10-19T08:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
    ]);
    const old = r.events.filter((e) => e.uid.startsWith('old'));
    expect(old).toHaveLength(15);
    expect(iso(old[0]!.start)).toBe('2026-10-19T08:00:00.000Z');
  });

  it('keeps the first occurrence of rules it does not expand, and stops at the limit', () => {
    const hourly = parseIcs(
      wrap(vevent(['UID:h', 'DTSTART:20261005T100000Z', 'RRULE:FREQ=HOURLY;COUNT=5'])),
      opts,
    );
    expect(hourly).toMatchObject({
      simplified: 1,
      events: [{ uid: 'h/2026-10-05T10:00:00.000Z' }],
    });
    const many = parseIcs(
      wrap(vevent(['UID:m', 'DTSTART:20261005T100000Z', 'RRULE:FREQ=DAILY;COUNT=50'])),
      { ...opts, maxEvents: 10 },
    );
    expect(many.events).toHaveLength(10);
    expect(many.truncated).toBe(true);
  });

  it('zones and durations', () => {
    expect(resolveZone('Europe/Paris', 'UTC')).toBe('Europe/Paris');
    expect(resolveZone('Russian Standard Time', 'UTC')).toBe('Europe/Moscow');
    expect(resolveZone('Nowhere/Land', 'Asia/Omsk')).toBe('Asia/Omsk');
    expect(durationSec('P1W')).toBe(604_800);
    expect(durationSec('PT1H30M')).toBe(5400);
    expect(durationSec('P')).toBeNull();
  });
});
