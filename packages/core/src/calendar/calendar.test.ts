import { describe, expect, it } from 'vitest';
import { toICal } from './calendar.ts';

const base = {
  scope: 'COURSE' as const,
  courseId: 'c1',
  groupId: null,
  userId: null,
  moduleKey: 'assign',
  kind: 'DUE' as const,
  description: 'Line 1\nLine, 2; done',
  location: '',
  subscriptionId: null,
  uid: null,
  allDay: false,
  visible: true,
  createdById: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('toICal', () => {
  it('produces a valid calendar with escaped text and CRLF', () => {
    const ics = toICal(
      [
        {
          ...base,
          id: 'e1',
          activityId: 'a1',
          title: 'Эссе',
          startsAt: new Date('2026-05-01T09:00:00Z'),
          endsAt: null,
          courseName: 'История',
        },
        {
          ...base,
          id: 'e2',
          activityId: null,
          title: 'Каникулы',
          location: 'Дача, 2 км',
          allDay: true,
          startsAt: new Date('2026-05-09T00:00:00Z'),
          endsAt: null,
        },
      ],
      { name: 'Hubium', host: 'lms.example', baseUrl: 'https://lms.example' },
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:e1@lms.example');
    expect(ics).toContain('DTSTART:20260501T090000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260509');
    expect(ics).toContain('SUMMARY:Эссе (История)');
    expect(ics).toContain('DESCRIPTION:Line 1\\nLine\\, 2\\; done');
    expect(ics).toContain('LOCATION:Дача\\, 2 км');
    expect(ics).toContain('URL:https://lms.example/course/c1/a/a1');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('folds long lines at 75 octets', () => {
    const ics = toICal(
      [
        {
          ...base,
          id: 'e3',
          activityId: null,
          title: 'Ж'.repeat(80),
          startsAt: new Date(),
          endsAt: null,
        },
      ],
      {
        name: 'x',
        host: 'h',
        baseUrl: 'https://h',
      },
    );
    for (const line of ics.split('\r\n'))
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });
});
