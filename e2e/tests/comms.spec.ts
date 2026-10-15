import { expect, test } from '@playwright/test';
import { sql } from './db';
import { DEMO_PASSWORD, expectAccessible, login } from './helpers';
import { waitForMail } from './mail';

// Realtime messaging between two browsers, live notification badge, forum replies,
// announcements by email and one-click unsubscribe without signing in.

async function ids() {
  const users = Object.fromEntries(
    (
      await sql<{ id: string; username: string }>(
        `SELECT id, username FROM "User" WHERE username IN ('student1','student2','teacher')`,
      )
    ).map((u) => [u.username, u.id]),
  );
  const [c] = await sql<{ id: string; forum: string }>(
    `SELECT c.id, (SELECT id FROM "Activity" WHERE "courseId" = c.id AND "moduleKey" = 'forum'
       AND "deletedAt" IS NULL LIMIT 1) AS forum FROM "Course" c WHERE c."shortName" = 'DEMO-PY'`,
  );
  if (!c?.forum) throw new Error('Run pnpm db:seed first (demo forum)');
  return { users, courseId: c.id, forumId: c.forum };
}

test.describe
  .serial('communications', () => {
    let d: Awaited<ReturnType<typeof ids>>;

    test.beforeAll(async () => {
      d = await ids();
      const key = [d.users.student1, d.users.student2].sort().join(':');
      await sql(`DELETE FROM "Conversation" WHERE "directKey" = $1`, [key]);
      await sql(`DELETE FROM "UserBlock" WHERE "userId" = ANY($1::uuid[])`, [
        [d.users.student1, d.users.student2],
      ]);
      await sql(`DELETE FROM "NotificationPreference" WHERE "userId" = $1`, [d.users.student2]);
      await sql(`UPDATE "User" SET "messagePrivacy" = 'COURSEMATES' WHERE id = $1`, [
        d.users.student2,
      ]);
    });

    test('two browsers exchange messages in under a second', async ({ browser }) => {
      const thread = (p: import('@playwright/test').Page) => p.locator('ol[aria-live]');
      const a = await browser.newContext();
      const b = await browser.newContext();
      const pa = await a.newPage();
      const pb = await b.newPage();
      await login(pa, 'student1', DEMO_PASSWORD);
      await login(pb, 'student2', DEMO_PASSWORD);

      await pb.goto('/messages');
      await pa.goto(`/profile/${d.users.student2}`);
      await pa.getByRole('button', { name: 'Написать' }).click();
      await pa.waitForURL(/\/messages\/[0-9a-f-]{36}/);
      await expectAccessible(pa);

      const box = pa.getByRole('textbox', { name: 'Напишите сообщение…' });
      await box.fill('Привет из первого браузера');
      await pa.getByRole('button', { name: 'Отправить' }).click();
      await expect(thread(pa).getByText('Привет из первого браузера')).toBeVisible();

      // the conversation appears in the other browser's list without reloading
      const item = pb.getByRole('link', { name: /Иван Петров/ });
      await expect(item).toBeVisible();
      await item.click();
      await pb.waitForURL(/\/messages\/[0-9a-f-]{36}/);
      await expect(thread(pb).getByText('Привет из первого браузера')).toBeVisible();

      // typing indicator
      await pa.getByRole('textbox', { name: 'Напишите сообщение…' }).pressSequentially('Ещё');
      await expect(pb.getByText('Иван Петров печатает…')).toBeVisible();
      await pa.getByRole('textbox', { name: 'Напишите сообщение…' }).fill('');

      // latency: from sending to the message on the other screen, timed by the pages
      // themselves rather than by Playwright's polling
      const text = `Пинг ${Date.now()}`;
      await pa.getByRole('textbox', { name: 'Напишите сообщение…' }).fill(text);
      await pb.evaluate((t) => {
        (window as unknown as { seen: Promise<number> }).seen = new Promise((done) => {
          const check = () => document.body.innerText.includes(t) && done(Date.now());
          new MutationObserver(check).observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true,
          });
          check();
        });
      }, text);
      const started = await pa.evaluate(() => Date.now());
      await pa.getByRole('textbox', { name: 'Напишите сообщение…' }).press('Enter');
      await expect(thread(pb).getByText(text)).toBeVisible({ timeout: 5000 });
      const seen = await pb.evaluate(() => (window as unknown as { seen: Promise<number> }).seen);
      expect(seen - started).toBeLessThan(1000);

      // reply comes back live as well
      await pb.getByRole('textbox', { name: 'Напишите сообщение…' }).fill('Получил!');
      await pb.getByRole('button', { name: 'Отправить' }).click();
      await expect(thread(pa).getByText('Получил!')).toBeVisible();
      await expectAccessible(pb);
      await a.close();
      await b.close();
    });

    test('forum reply shows up in the author’s bell live', async ({ browser }) => {
      const a = await browser.newContext();
      const b = await browser.newContext();
      const author = await a.newPage();
      const replier = await b.newPage();
      await login(author, 'student1', DEMO_PASSWORD);
      await login(replier, 'student2', DEMO_PASSWORD);
      await sql(`UPDATE "Notification" SET "readAt" = now() WHERE "userId" = $1`, [
        d.users.student1,
      ]);

      // student1 starts a discussion
      await author.goto(`/course/${d.courseId}/a/${d.forumId}`);
      const title = `Вопрос ${Date.now().toString(36)}`;
      await author.getByRole('button', { name: 'Новая тема' }).click();
      await author.locator('#fd-title').fill(title);
      await author.locator('#fd-message').click();
      await author.keyboard.type('Помогите разобраться со списками');
      await author.getByRole('button', { name: 'Отправить' }).click();
      await author.waitForURL(/\?d=/);
      await expect(author.getByRole('heading', { name: title })).toBeVisible();
      await expectAccessible(author);
      await author.goto('/dashboard');
      await expect(author.getByRole('button', { name: 'Уведомления', exact: true })).toBeVisible();

      // student2 replies
      await replier.goto(`/course/${d.courseId}/a/${d.forumId}`);
      await replier.getByRole('link', { name: title }).click();
      await replier.getByRole('button', { name: 'Ответить' }).first().click();
      await replier.locator('[id^="msg-"]').first().click();
      await replier.keyboard.type('Список — изменяемая последовательность');
      await replier.getByRole('button', { name: 'Отправить' }).click();
      await expect(replier.getByText('Список — изменяемая последовательность')).toBeVisible();

      // the author's bell updates without a reload
      const bell = author.getByRole('button', { name: /Уведомления: 1/ });
      await expect(bell).toBeVisible();
      await bell.click();
      await expect(author.getByRole('menuitem', { name: new RegExp(title) })).toBeVisible();
      await author.getByRole('menuitem', { name: new RegExp(title) }).click();
      await author.waitForURL(/\?d=.*#p-/);
      await expect(author.getByText('Список — изменяемая последовательность')).toBeVisible();
      await a.close();
      await b.close();
    });

    test('announcement email and one-click unsubscribe without signing in', async ({
      page,
      browser,
    }) => {
      const since = new Date();
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto(`/course/${d.courseId}/stream`);
      const title = `Объявление ${Date.now().toString(36)}`;
      await page.getByRole('button', { name: 'Новое объявление' }).click();
      await page.locator('#f-title').fill(title);
      await page.locator('#f-contentHtml').click();
      await page.keyboard.type('Занятие переносится на среду.');
      await page.getByRole('button', { name: 'Новое объявление' }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
      await expectAccessible(page);

      const mail = await waitForMail('student2@hubium.local', {
        subject: new RegExp(title),
        after: since,
      });
      expect(mail.Text).toContain('Занятие переносится на среду.');
      const link = mail.Text.match(/https?:\/\/\S+\/unsubscribe\/\S+/)?.[0];
      expect(link).toBeTruthy();

      const anon = await browser.newContext();
      const p = await anon.newPage();
      await p.goto(new URL(link!).pathname);
      await p.getByRole('button', { name: 'Отписаться от таких писем' }).click();
      await expect(
        p.getByText('Готово: письма этого типа больше не будут приходить.'),
      ).toBeVisible();
      await expectAccessible(p);
      await anon.close();
      const [pref] = await sql<{ email: string }>(
        `SELECT email::text FROM "NotificationPreference" WHERE "userId" = $1 AND type = 'announcement.course'`,
        [d.users.student2],
      );
      expect(pref?.email).toBe('OFF');
    });
  });
