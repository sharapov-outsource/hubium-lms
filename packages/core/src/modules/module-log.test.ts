import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { runModuleAction } from './actions.ts';

describe('module events', () => {
  const t = useTestDb();

  it('go to the course log, with the activity and the person they concern', async () => {
    const f = await courseFixture(t.db, 'MODLOG');
    const { id } = await f.addActivity('assign', 'Эссе', { gradeMax: 10 });
    await runModuleAction(await ctxFor(t.db, f.users.student1!), id, 'saveSubmission', {
      text: '<p>Работа</p>',
      submit: true,
    });
    await runModuleAction(await ctxFor(t.db, f.users.teacher!), id, 'grade', {
      userId: f.users.student1,
      grade: 8,
    });
    const logged = await t.db.eventLog.findMany({
      where: { courseId: f.courseId, name: { in: ['assign.submission.saved', 'assign.graded'] } },
      orderBy: { id: 'asc' },
    });
    expect(logged.map((e) => [e.name, e.contextId, e.actorId, e.relatedUserId])).toEqual([
      ['assign.submission.saved', id, f.users.student1, null],
      ['assign.graded', id, f.users.teacher, f.users.student1],
    ]);
  });
});
