import { createDb, type Db } from '@hubium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { saveUserEvidence } from '../competencies/plans.ts';
import type { RequestContext } from '../context.ts';
import { saveActivityFiles } from '../courses/activities.ts';
import { setCourseImage, storeEditorImage } from '../courses/courses.ts';
import { ForbiddenError } from '../errors.ts';

// Files people add are stored by operations; the blobs they hold are written in the files
// scope, so all of it passes the strict write guard.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('file operations', () => {
  const t = useTestDb();
  let db: Db;
  let f: Awaited<ReturnType<typeof courseFixture>>;
  const strict = async (email: string): Promise<RequestContext> => ({
    ...(await ctxFor(t.db, email)),
    db,
  });

  beforeAll(async () => {
    f = await courseFixture(t.db, 'FILES');
    db = createDb({ url: t.tdb.url, max: 2, writeGuard: 'strict' });
  });
  afterAll(() => db?.$disconnect());

  it('sets and removes the cover of a course', async () => {
    const teacher = await strict('teacher@hubium.local');
    const image = { name: 'cover.png', mimeType: 'image/png', data: PNG };
    const { fileId } = await setCourseImage.run(teacher, { courseId: f.courseId, image });
    expect((await db.course.findUniqueOrThrow({ where: { id: f.courseId } })).imageFileId).toBe(
      fileId,
    );
    await setCourseImage.run(teacher, { courseId: f.courseId, image: null });
    expect(
      (await db.course.findUniqueOrThrow({ where: { id: f.courseId } })).imageFileId,
    ).toBeNull();
    const student = await strict('student1@hubium.local');
    await expect(
      setCourseImage.run(student, { courseId: f.courseId, image }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stores a picture of the editor in the course's area", async () => {
    const teacher = await strict('teacher@hubium.local');
    const { url } = await storeEditorImage.run(teacher, {
      courseId: f.courseId,
      name: 'pic.png',
      mimeType: 'image/png',
      data: PNG,
    });
    expect(url).toMatch(/^\/files\/[0-9a-f-]{36}\/pic\.png$/);
  });

  it("adds files to an activity's area and removes them", async () => {
    const teacher = await strict('teacher@hubium.local');
    const { id: activityId } = await f.addActivity('file', 'Files', {});
    const data = Buffer.from('notes');
    await saveActivityFiles.run(teacher, {
      activityId,
      add: [{ area: 'content', name: 'a.txt', mimeType: 'text/plain', data }],
    });
    const [file] = await db.file.findMany({ where: { contextId: activityId, area: 'content' } });
    expect(file?.name).toBe('a.txt');
    await saveActivityFiles.run(teacher, { activityId, remove: [file!.id] });
    expect(await db.file.count({ where: { contextId: activityId, area: 'content' } })).toBe(0);
  });

  it('stores the files of evidence of prior learning with it', async () => {
    const student = await strict('student1@hubium.local');
    const { id } = await saveUserEvidence.run(student, {
      name: 'Сертификат',
      files: [{ name: 'cert.png', mimeType: 'image/png', data: PNG }],
    });
    expect(await db.file.count({ where: { itemId: id, area: 'userevidence' } })).toBe(1);
  });
});
