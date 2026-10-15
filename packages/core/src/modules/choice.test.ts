import type { ChoiceResults } from '@hubium/mod-choice/server';
import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { updateActivity } from '../courses/activities.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import { runModuleAction, runModuleQuery } from './actions.ts';

type Results = ChoiceResults & { mine: string[] };

describe('mod-choice', () => {
  const t = useTestDb();

  it('takes answers within limits and shows results as the settings say', async () => {
    const f = await courseFixture(t.db, 'CHOICE1');
    const { id } = await f.addActivity('choice', 'Тема проекта', {
      options: JSON.stringify([
        { text: 'Чат-бот', limit: 1 },
        { text: 'Игра', limit: 2 },
      ]),
      limitAnswers: true,
      allowUpdate: false,
      showResults: 'afterAnswer',
      publish: 'names',
    });
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const [bot, game] = (act.settings as { options: { id: string }[] }).options.map((o) => o.id);
    const s1 = await ctxFor(t.db, f.users.student1!);
    const s2 = await ctxFor(t.db, f.users.student2!);
    const s3 = await ctxFor(t.db, f.users.student3!);
    const results = async (who = s1) => (await runModuleQuery(who, id, 'results', {})) as Results;

    // nothing to see before answering
    expect((await results(s2)).visible).toBe(false);
    await runModuleAction(s1, id, 'answer', { optionIds: [bot] });
    await expect(runModuleAction(s2, id, 'answer', { optionIds: [bot] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(runModuleAction(s2, id, 'answer', { optionIds: [bot, game] })).rejects.toThrow(
      'Choose one option only',
    );
    await runModuleAction(s2, id, 'answer', { optionIds: [game] });
    // changing is not allowed here
    await expect(runModuleAction(s1, id, 'answer', { optionIds: [game] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const r = await results(s1);
    expect(r).toMatchObject({ visible: true, names: true, answered: 2, mine: [bot] });
    expect(r.options.map((o) => [o.text, o.count, o.users.map((u) => u.name).length])).toEqual([
      ['Чат-бот', 1, 1],
      ['Игра', 1, 1],
    ]);
    // the teacher also sees who has not answered
    const teacher = await ctxFor(t.db, f.users.teacher!);
    expect((await results(teacher)).unanswered?.map((u) => u.id)).toEqual([f.users.student3]);

    await runModuleAction(teacher, id, 'deleteResponses', { userIds: [f.users.student1!] });
    await runModuleAction(s3, id, 'answer', { optionIds: [bot] });
    expect((await results(teacher)).options[0]!.users.map((u) => u.id)).toEqual([f.users.student3]);
  });

  it('keeps learners in separate groups to their group, and respects the dates', async () => {
    const f = await courseFixture(t.db, 'CHOICE2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id } = await f.addActivity(
      'choice',
      'Дежурство',
      {
        options: JSON.stringify([{ text: 'Пн' }, { text: 'Вт' }]),
        allowMultiple: true,
        showResults: 'always',
      },
      { groupMode: 'SEPARATE' },
    );
    const a = await createGroup.run(teacher, { courseId: f.courseId, name: 'А' });
    await setGroupMembers.run(teacher, { groupId: a.id, add: [f.users.student1!] });
    const b = await createGroup.run(teacher, { courseId: f.courseId, name: 'Б' });
    await setGroupMembers.run(teacher, { groupId: b.id, add: [f.users.student2!] });
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const [mon, tue] = (act.settings as { options: { id: string }[] }).options.map((o) => o.id);
    const s1 = await ctxFor(t.db, f.users.student1!);
    const s2 = await ctxFor(t.db, f.users.student2!);
    await runModuleAction(s1, id, 'answer', { optionIds: [mon, tue] });
    await runModuleAction(s2, id, 'answer', { optionIds: [mon] });
    const seen = (await runModuleQuery(s2, id, 'results', {})) as Results;
    // anonymous: counts only, and only of the own group
    expect(seen).toMatchObject({ names: false, answered: 1 });
    expect(seen.options.map((o) => o.count)).toEqual([1, 0]);
    expect(((await runModuleQuery(teacher, id, 'results', {})) as Results).answered).toBe(2);

    await t.db.activity.update({
      where: { id },
      data: { settings: { ...(act.settings as object), closesAt: '2020-01-01T00:00:00Z' } },
    });
    await expect(runModuleAction(s1, id, 'withdraw', {})).rejects.toThrow('closed');
  });

  it('an option taken away takes its answers, and the completion they gave', async () => {
    const f = await courseFixture(t.db, 'CHOICE3');
    const { id } = await f.addActivity(
      'choice',
      'Дежурство',
      { options: JSON.stringify([{ text: 'Понедельник' }, { text: 'Вторник' }]) },
      { completionMode: 'AUTO', completionRules: { module: { submitted: true } } },
    );
    const act = await t.db.activity.findUniqueOrThrow({ where: { id } });
    const options = (act.settings as { options: { id: string; text: string }[] }).options;
    const s1 = await ctxFor(t.db, f.users.student1!);
    await runModuleAction(s1, id, 'answer', { optionIds: [options[0]!.id] });
    const state = async () =>
      (
        await t.db.activityCompletion.findUnique({
          where: { activityId_userId: { activityId: id, userId: f.users.student1! } },
        })
      )?.state;
    expect(await state()).toBe('COMPLETE');
    await updateActivity.run(await ctxFor(t.db, f.users.teacher!), {
      id,
      name: act.name,
      settings: { ...(act.settings as object), options: JSON.stringify([options[1]]) },
      completionMode: 'AUTO',
      completionRules: { module: { submitted: true } },
    });
    expect(await t.db.choiceAnswer.count({ where: { activityId: id } })).toBe(0);
    expect(await state()).toBe('INCOMPLETE');
  });
});
