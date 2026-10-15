import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ValidationError } from '../errors.ts';
import {
  createActivity,
  getActivityAccess,
  getCourseOutline,
  moveActivity,
  moveActivityStep,
} from './activities.ts';
import {
  addSection,
  deleteSection,
  moveSection,
  moveSubsection,
  setSectionVisible,
  updateSection,
} from './courses.ts';
import { sectionItems } from './section-items.ts';

describe('subsections', () => {
  const t = useTestDb();

  it('sit among their section’s activities, move with them and are hidden with it', async () => {
    const f = await courseFixture(t.db, 'SUBSEC1');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const student = await ctxFor(t.db, f.users.student1!);
    const [s0, s1] = await t.db.courseSection.findMany({
      where: { courseId: f.courseId },
      orderBy: { rank: 'asc' },
    });
    const page = (sectionId: string, name: string) =>
      createActivity.run(teacher, {
        courseId: f.courseId,
        sectionId,
        moduleKey: 'page',
        name,
        settings: { content: `<p>${name}</p>` },
      });
    const a = await page(s1!.id, 'A');
    const b = await page(s1!.id, 'B');
    const { id: sub } = await addSection.run(teacher, {
      courseId: f.courseId,
      parentId: s1!.id,
      title: 'Практика',
    });
    // one level, as in Moodle
    await expect(
      addSection.run(teacher, { courseId: f.courseId, parentId: sub, title: 'Глубже' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const c = await page(sub, 'C');
    // a new activity goes after the subsection
    const d = await page(s1!.id, 'D');
    const order = async (sectionId: string) =>
      (await sectionItems(t.db, sectionId)).map((x) => x.id);
    expect(await order(s1!.id)).toEqual([a.id, b.id, sub, d.id]);

    const outline = await getCourseOutline(student, f.courseId);
    expect(outline.map((s) => [s.id, s.parentId, s.index])).toEqual([
      [s0!.id, null, 0],
      [s1!.id, null, 1],
      [sub, s1!.id, 1],
    ]);
    expect(outline[2]!.activities.map((x) => x.activity.name)).toEqual(['C']);

    // up and down past activities, and activities past it
    await moveSection.run(teacher, { id: sub, direction: 'up' });
    expect(await order(s1!.id)).toEqual([a.id, sub, b.id, d.id]);
    await moveActivityStep.run(teacher, { id: a.id, direction: 'down' });
    expect(await order(s1!.id)).toEqual([sub, a.id, b.id, d.id]);
    await moveActivity.run(teacher, { id: d.id, sectionId: s1!.id, beforeId: sub });
    expect(await order(s1!.id)).toEqual([d.id, sub, a.id, b.id]);

    // hidden with its section, or on its own
    await setSectionVisible.run(teacher, { id: s1!.id, visible: false });
    expect((await getCourseOutline(student, f.courseId)).map((s) => s.id)).toEqual([s0!.id]);
    expect((await getActivityAccess(student, c.id)).canOpen).toBe(false);
    // editors still see it all
    expect((await getCourseOutline(teacher, f.courseId)).map((s) => s.id)).toContain(sub);
    await setSectionVisible.run(teacher, { id: s1!.id, visible: true });
    await setSectionVisible.run(teacher, { id: sub, visible: false });
    expect((await getCourseOutline(student, f.courseId)).map((s) => s.id)).toEqual([
      s0!.id,
      s1!.id,
    ]);
    await setSectionVisible.run(teacher, { id: sub, visible: true });

    // its section's restrictions apply to it
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await updateSection.run(teacher, {
      id: s1!.id,
      title: '',
      availability: { op: '&', c: [{ type: 'date', op: '>=', at: later }] },
    });
    const restricted = (await getCourseOutline(student, f.courseId)).find((s) => s.id === sub)!;
    expect(restricted.available).toBe(false);
    expect(restricted.activities[0]).toMatchObject({ available: false });
    expect(restricted.activities[0]!.availabilityMissing).toHaveLength(1);
    expect((await getActivityAccess(student, c.id)).canOpen).toBe(false);
    await updateSection.run(teacher, { id: s1!.id, title: '', availability: null });
    expect((await getActivityAccess(student, c.id)).canOpen).toBe(true);

    // into another section, with its activities
    await moveSubsection.run(teacher, { id: sub, parentId: s0!.id });
    expect(await order(s0!.id)).toEqual([sub]);
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: c.id } })).sectionId).toBe(sub);
    await expect(
      moveSubsection.run(teacher, { id: s1!.id, parentId: s0!.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a section with subsections, or a subsection with activities, is not deleted', async () => {
    const f = await courseFixture(t.db, 'SUBSEC2');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const { id: s2 } = await addSection.run(teacher, { courseId: f.courseId, title: 'Тема 2' });
    const { id: sub } = await addSection.run(teacher, {
      courseId: f.courseId,
      parentId: s2,
      title: 'Практика',
    });
    const refused = (what: RegExp) => ({ fieldErrors: { id: [expect.stringMatching(what)] } });
    await expect(deleteSection.run(teacher, { id: s2 })).rejects.toMatchObject(
      refused(/subsections/),
    );
    const page = await createActivity.run(teacher, {
      courseId: f.courseId,
      sectionId: sub,
      moduleKey: 'page',
      name: 'Внутри',
      settings: { content: '<p>x</p>' },
    });
    await expect(deleteSection.run(teacher, { id: sub })).rejects.toMatchObject(
      refused(/activities/),
    );
    await moveActivity.run(teacher, { id: page.id, sectionId: s2 });
    await deleteSection.run(teacher, { id: sub });
    expect(await t.db.courseSection.count({ where: { parentId: s2 } })).toBe(0);
    // sections of the course keep their own order
    const { id: s3 } = await addSection.run(teacher, { courseId: f.courseId, title: 'Тема 3' });
    const top = await t.db.courseSection.findMany({
      where: { courseId: f.courseId, parentId: null },
      orderBy: { rank: 'asc' },
    });
    expect(top.at(-1)!.id).toBe(s3);
  });
});
