import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { useTestDb } from '../../test/helpers.ts';
import { sendCalendarReminders } from './calendar.ts';

describe('calendar reminders', () => {
  const t = useTestDb();

  it('remind once, even when runs overlap, and not for hidden courses', async () => {
    const f = await courseFixture(t.db, 'REMIND1');
    const hidden = await courseFixture(t.db, 'REMIND2');
    await t.db.course.update({ where: { id: hidden.courseId }, data: { visible: false } });
    const now = new Date();
    const startsAt = new Date(now.getTime() + 24 * 3600_000 + 10 * 60_000);
    for (const courseId of [f.courseId, hidden.courseId])
      await t.db.calendarEvent.create({
        data: { scope: 'COURSE', courseId, kind: 'CUSTOM', title: 'Семинар', startsAt },
      });
    const count = (courseId: string) =>
      t.db.notification.count({ where: { type: 'calendar.reminder', courseId } });
    expect(await sendCalendarReminders(t.db, now)).toBe(4);
    // the next hourly run still sees the event in its window but does not repeat it
    expect(await sendCalendarReminders(t.db, new Date(now.getTime() + 3600_000))).toBe(0);
    expect(await count(f.courseId)).toBe(4);
    expect(await count(hidden.courseId)).toBe(0);
  });
});
