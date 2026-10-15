import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { courseEventLog } from './course-log.ts';

describe('course event log', () => {
  const t = useTestDb();

  it('filters by who, what, which activity and when, and pages by a cursor', async () => {
    const f = await courseFixture(t.db, 'LOG1');
    const { id: activityId } = await f.addActivity('page', 'Страница', {});
    const student = await t.db.user.findUniqueOrThrow({ where: { id: f.users.student1! } });
    const at = (d: string) => new Date(`${d}T12:00:00Z`);
    await t.db.eventLog.createMany({
      data: [
        ...Array.from({ length: 5 }, (_, i) => ({
          name: 'activity.viewed',
          actorId: student.id,
          courseId: f.courseId,
          contextId: activityId,
          origin: 'WEB' as const,
          createdAt: at(`2026-03-0${i + 1}`),
        })),
        {
          name: 'course.updated',
          actorId: f.users.teacher!,
          courseId: f.courseId,
          origin: 'WEB' as const,
          createdAt: at('2026-03-10'),
        },
      ],
    });
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const log = (q: Parameters<typeof courseEventLog>[2]) => courseEventLog(teacher, f.courseId, q);

    expect((await log({ name: 'course.updated' })).items).toHaveLength(1);
    const views = await log({ who: student.name.slice(0, 4), activityId });
    expect(views.items).toHaveLength(5);
    expect(views.items[0]!.actor).toBe(student.name);
    expect(
      (await log({ name: 'activity.viewed', from: at('2026-03-02'), to: at('2026-03-04') })).items,
    ).toHaveLength(2);

    // two at a time, the latest first, until there are no more
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await log({ name: 'activity.viewed', limit: 2, before });
      seen.push(...page.items.map((l) => l.createdAt.toISOString().slice(0, 10)));
      before = page.next ?? undefined;
    } while (before);
    expect(seen).toEqual(['2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01']);

    // a learner may not read it
    const s = await ctxFor(t.db, student.id);
    await expect(courseEventLog(s, f.courseId)).rejects.toThrow();
  });
});
