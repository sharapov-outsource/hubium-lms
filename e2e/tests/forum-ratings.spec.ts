import { expect, test } from '@playwright/test';
import { sql } from './db';
import { chooseOption, DEMO_PASSWORD, expectAccessible, login } from './helpers';

// Ratings and whole-forum grading in the demo forum: the teacher rates a student's post
// and grades their part in the forum; the student sees both on a phone.

test('forum: a teacher rates a post and grades the whole forum', async ({ page }) => {
  const [row] = await sql<{
    courseId: string;
    forumId: string;
    settings: object;
    discussionId: string;
    name: string;
  }>(
    `SELECT c.id AS "courseId", a.id AS "forumId", a.settings, d.id AS "discussionId", u.name
       FROM "Course" c
       JOIN "Activity" a ON a."courseId" = c.id AND a."moduleKey" = 'forum'
       JOIN "ForumDiscussion" d ON d."activityId" = a.id AND d.title = 'Как установить Python на Windows?'
       JOIN "User" u ON u.username = 'student1'
      WHERE c."shortName" = 'DEMO-PY' LIMIT 1`,
  );
  const { courseId, forumId, settings, discussionId, name } = row!;
  const forum = `/course/${courseId}/a/${forumId}`;
  const cleanup = async () => {
    await sql(`UPDATE "Activity" SET settings = $2 WHERE id = $1`, [forumId, settings]);
    await sql(
      `DELETE FROM "ForumRating" WHERE "postId" IN (SELECT p.id FROM "ForumPost" p
         JOIN "ForumDiscussion" d ON d.id = p."discussionId" WHERE d."activityId" = $1)`,
      [forumId],
    );
    await sql(`DELETE FROM "ForumGrade" WHERE "activityId" = $1`, [forumId]);
    await sql(`DELETE FROM "GradeItem" WHERE "activityId" = $1`, [forumId]);
  };
  await cleanup();
  await sql(`UPDATE "Activity" SET settings = settings || $2::jsonb WHERE id = $1`, [
    forumId,
    JSON.stringify({
      ratingAggregate: 'average',
      ratingMax: 10,
      wholeForumGrading: true,
      gradeMax: 20,
    }),
  ]);
  try {
    // the teacher rates the student's question
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${forum}?d=${discussionId}`);
    const rate = page.getByRole('combobox', { name: `Ваша оценка поста: ${name}` });
    await chooseOption(rate, '8');
    await expect(page.getByText('Средний рейтинг: 8')).toBeVisible();
    await expectAccessible(page);

    // and grades the student's part in the whole forum
    await page.goto(forum);
    await page.getByRole('link', { name: 'Оценить участие студентов' }).click();
    await page.getByRole('link', { name: `Оценить: ${name}` }).click();
    await expect(page.getByText('Скачал установщик').first()).toBeVisible();
    await page.locator('#forum-grade').fill('17');
    await page.locator('#forum-feedback').click();
    await page.keyboard.type('Хорошие вопросы');
    await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
    await expectAccessible(page);
    await page.context().clearCookies();

    // the student sees the grade and the rating of their post, on a phone
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page, 'student1', DEMO_PASSWORD);
    await page.goto(forum);
    await expect(page.getByText('Ваша оценка за форум: 17 из 20')).toBeVisible();
    await expect(page.getByText('Хорошие вопросы')).toBeVisible();
    await expectAccessible(page);
    await page.goto(`${forum}?d=${discussionId}`);
    await expect(page.getByText('Средний рейтинг: 8')).toBeVisible();
    // their own post is not theirs to rate
    await expect(page.getByRole('combobox', { name: /Ваша оценка поста/ })).toHaveCount(0);
    await expectAccessible(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    ).toBe(false);
    await page.context().clearCookies();

    // the rating and the grade taken back (the course total follows)
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'teacher', DEMO_PASSWORD);
    await page.goto(`${forum}?d=${discussionId}`);
    await chooseOption(rate, { label: '—' });
    await expect(page.getByText('Средний рейтинг: 8')).toHaveCount(0);
    await page.goto(`${forum}?tab=grading`);
    await page.getByRole('link', { name: `Оценить: ${name}` }).click();
    await page.locator('#forum-grade').fill('');
    await page.getByRole('button', { name: 'Сохранить оценку', exact: true }).click();
    await expect(page.getByText('Оценка сохранена').first()).toBeVisible();
  } finally {
    await cleanup();
  }
});
