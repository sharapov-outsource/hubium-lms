import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login, logout } from './helpers';

// Separate groups in the demo course: «Поток А» (student1, student2) and a second stream
// with student3 and the assistant, a non-editing teacher here kept to their own groups.
// A learner sees the members and discussions of their group only, even when they ask for
// the other group; the assistant marks only their group's work; the teacher sees everyone.

const GROUP_B = 'E2E Поток Б';
const TOPIC = 'E2E обсуждение потока А';

test('separate groups: participants, forum and assignment', async ({ page }) => {
  test.slow();
  const [row] = await sql<{
    courseId: string;
    courseMode: string;
    forumId: string;
    forumMode: string;
    assignId: string;
    assignMode: string;
    groupA: string;
    teacherRole: string;
    assistant: string;
    s3: string;
  }>(
    `SELECT c.id AS "courseId", c."groupMode" AS "courseMode",
            f.id AS "forumId", f."groupMode" AS "forumMode",
            a.id AS "assignId", a."groupMode" AS "assignMode",
            (SELECT id FROM "Group" WHERE "courseId" = c.id AND name = 'Поток А') AS "groupA",
            (SELECT id FROM "Role" WHERE "shortName" = 'teacher') AS "teacherRole",
            (SELECT id FROM "User" WHERE username = 'assistant') AS assistant,
            (SELECT id FROM "User" WHERE username = 'student3') AS s3
       FROM "Course" c
       JOIN "Activity" f ON f."courseId" = c.id AND f."moduleKey" = 'forum'
       JOIN "ForumDiscussion" d ON d."activityId" = f.id AND d.title = 'Как установить Python на Windows?'
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'assign'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const r = row!;
  const names = Object.fromEntries(
    (
      await sql<{ username: string; name: string }>(
        `SELECT username, name FROM "User" WHERE username IN ('student1', 'student2', 'student3')`,
      )
    ).map((u) => [u.username, u.name]),
  );
  const forum = `/course/${r.courseId}/a/${r.forumId}`;
  const assign = `/course/${r.courseId}/a/${r.assignId}`;
  const participants = `/course/${r.courseId}/participants`;
  const cleanup = async () => {
    await sql(`UPDATE "Course" SET "groupMode" = $2::"GroupMode" WHERE id = $1`, [
      r.courseId,
      r.courseMode,
    ]);
    await sql(`UPDATE "Activity" SET "groupMode" = $2::"GroupMode" WHERE id = $1`, [
      r.forumId,
      r.forumMode,
    ]);
    await sql(`UPDATE "Activity" SET "groupMode" = $2::"GroupMode" WHERE id = $1`, [
      r.assignId,
      r.assignMode,
    ]);
    await sql(`DELETE FROM "ForumDiscussion" WHERE "activityId" = $1 AND title = $2`, [
      r.forumId,
      TOPIC,
    ]);
    await sql(`DELETE FROM "Group" WHERE "courseId" = $1 AND name = $2`, [r.courseId, GROUP_B]);
    await sql(
      `DELETE FROM "RoleOverride" WHERE "contextId" = $1 AND "roleId" = $2 AND capability = 'group:accessall'`,
      [r.courseId, r.teacherRole],
    );
    await sql(`SELECT pg_notify('hubium_cache', 'roles')`);
  };
  await cleanup();
  await sql(`UPDATE "Course" SET "groupMode" = 'SEPARATE' WHERE id = $1`, [r.courseId]);
  await sql(`UPDATE "Activity" SET "groupMode" = 'SEPARATE' WHERE id IN ($1, $2)`, [
    r.forumId,
    r.assignId,
  ]);
  const [b] = await sql<{ id: string }>(
    `INSERT INTO "Group" (id, "courseId", name, "updatedAt") VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
    [r.courseId, GROUP_B],
  );
  await sql(`INSERT INTO "GroupMember" ("groupId", "userId") VALUES ($1, $2), ($1, $3)`, [
    b!.id,
    r.s3,
    r.assistant,
  ]);
  // the assistant (a non-editing teacher) may not see every group in this course
  await sql(
    `INSERT INTO "RoleOverride" ("contextId", "roleId", capability, permission) VALUES ($1, $2, 'group:accessall', 'DENY')`,
    [r.courseId, r.teacherRole],
  );
  await sql(`SELECT pg_notify('hubium_cache', 'roles')`);
  try {
    // student1 starts a discussion: their own group is the only one offered
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(forum);
    await page.getByRole('button', { name: 'Новая тема' }).click();
    await page.locator('#fd-group').click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Поток А']);
    await page.keyboard.press('Escape');
    await page.locator('#fd-title').fill(TOPIC);
    await page.locator('#fd-message').click();
    await page.keyboard.type('Только для нашего потока');
    await page.getByRole('button', { name: 'Отправить', exact: true }).click();
    await page.waitForURL(/\?d=[0-9a-f-]{36}/);
    const topic = new URL(page.url()).searchParams.get('d')!;
    await logout(page);

    // student3 sees neither the other group's members nor its discussion
    await login(page, 'student3', DEMO_PASSWORD);
    await page.goto(participants);
    const people = page.getByRole('main');
    await expect(people.getByRole('row').filter({ hasText: names.student3! })).toHaveCount(1);
    await expect(people.getByRole('row').filter({ hasText: names.student1! })).toHaveCount(0);
    await expect(people.getByRole('row').filter({ hasText: names.student2! })).toHaveCount(0);
    await expectAccessible(page);
    // asking for the other group by its address shows nobody from it
    await page.goto(`${participants}?group=${r.groupA}`);
    await expect(people.getByRole('row').filter({ hasText: names.student1! })).toHaveCount(0);
    await page.goto(forum);
    await expect(
      page.getByRole('link', { name: 'Как установить Python на Windows?' }),
    ).toBeVisible();
    await expect(page.getByText(TOPIC)).toHaveCount(0);
    await page.goto(`${forum}?d=${topic}`);
    await expect(page.getByText('Только для нашего потока')).toHaveCount(0);
    await logout(page);

    // the assistant marks the work of their group only
    await login(page, 'assistant', DEMO_PASSWORD);
    await page.goto(assign);
    const rows = page.getByRole('row');
    await expect(rows.filter({ hasText: names.student3! })).toHaveCount(1);
    await expect(rows.filter({ hasText: names.student1! })).toHaveCount(0);
    await expect(rows.filter({ hasText: names.student2! })).toHaveCount(0);
    await logout(page);

    // the teacher sees every group: all the students, and the discussion with its group
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(assign);
    for (const u of ['student1', 'student2', 'student3'])
      await expect(rows.filter({ hasText: names[u]! })).toHaveCount(1);
    await page.goto(forum);
    await expect(page.getByRole('link', { name: TOPIC })).toBeVisible();
    await expect(page.getByText('Поток А').first()).toBeVisible();
  } finally {
    await cleanup();
  }
});
