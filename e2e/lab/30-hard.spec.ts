import { type Browser, expect, type Page, test } from '@playwright/test';
import { demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { closeOpened, expectMode, signedIn } from './helpers';
import {
  agentState,
  cloudCompose,
  cloudServer,
  link,
  netemAvailable,
  onServer,
  power,
  whenMode,
} from './lab';

// What a branch's line and power do in real life: drops of a few seconds, a slow line that
// loses packets, the line cut again while the node syncs, the server switched off while it
// works alone or while it syncs, and an outage longer than the cloud keeps WAL for the
// node. Each time what people did reaches the cloud, and only once.

let ids: Awaited<ReturnType<typeof demoCourse>>;
let discussionId: string;

test.beforeAll(async () => {
  ids = await demoCourse();
  const [d] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  discussionId = d!.id;
});

const student = (browser: Browser) => signedIn(browser, 'student1');

async function reply(page: Page, text: string) {
  await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${discussionId}`);
  await page.getByRole('button', { name: 'Ответить' }).first().click();
  await page.locator('[id^="msg-"]').first().click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
  // taken: the form closes (until then the text is the editor's own) and the post shows
  await expect(page.locator('[id^="msg-"]')).toHaveCount(0);
  await expect(page.getByText(text)).toBeVisible();
}

async function inCloud(mark: string) {
  const [r] = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM "ForumPost" WHERE "contentHtml" LIKE $1`,
    [`%${mark}%`],
  );
  return r?.n ?? 0;
}

async function goOffline() {
  link(1, 'down');
  await expectMode(1, 'OFFLINE', 300_000);
}

test.describe
  .serial('the line and the power of a branch', () => {
    test.setTimeout(1_800_000);

    test.afterEach(async () => {
      link(1, 'up');
      await closeOpened();
    });

    test('short drops of the line do not make the node work alone', async ({ browser }) => {
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      const modes = new Set<string>();
      const watch = setInterval(() => {
        try {
          modes.add(agentState(1).mode);
        } catch {
          // between two answers
        }
      }, 500);
      const mark = `Между обрывами ${Date.now().toString(36)}`;
      try {
        for (let n = 1; n <= 3; n++) {
          // a dropped line, then one that refuses: both noticed, neither long enough
          link(1, n === 2 ? 'refuse' : 'down');
          await expectMode(1, 'READONLY', 120_000);
          link(1, 'up');
          await expectMode(1, 'ONLINE', 120_000);
          await reply(page, `${mark} №${n}`);
        }
      } finally {
        clearInterval(watch);
      }
      expect(modes.has('OFFLINE')).toBe(false);
      expect(await inCloud(mark)).toBe(3);
    });

    test('a slow line that loses packets still serves the branch', async ({ browser }) => {
      test.skip(!netemAvailable(), 'the kernel of this machine has no netem (tc) for a slow line');
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      link(1, 'slow');
      const mark = `По медленной линии ${Date.now().toString(36)}`;
      await reply(page, mark);
      expect(await inCloud(mark)).toBe(1);
      // a minute of it does not take the node off the line
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        expect(agentState(1).mode).toBe('ONLINE');
        await new Promise((ok) => setTimeout(ok, 5000));
      }
    });

    test('the line cut again during the sync: nothing lost, nothing twice', async ({ browser }) => {
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      await goOffline();
      const mark = `Обрыв посреди синхронизации ${Date.now().toString(36)}`;
      for (let n = 1; n <= 4; n++) await reply(page, `${mark} №${n}`);
      link(1, 'up');
      await whenMode(1, 'SYNC');
      link(1, 'down');
      await new Promise((ok) => setTimeout(ok, 30_000));
      link(1, 'up');
      await expectMode(1, 'ONLINE', 600_000);
      for (let n = 1; n <= 4; n++) expect(await inCloud(`${mark} №${n}`)).toBe(1);
    });

    test('the line goes again right after the sync: the work of both outages arrives', async ({
      browser,
    }) => {
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      await goOffline();
      const mark = `Два обрыва подряд ${Date.now().toString(36)}`;
      await reply(page, `${mark} №1`);
      link(1, 'up');
      // gone again before the cloud hears the node back on the line
      await whenMode(1, 'ONLINE');
      link(1, 'down');
      await expectMode(1, 'OFFLINE', 600_000);
      await reply(page, `${mark} №2`);
      link(1, 'up');
      await expectMode(1, 'ONLINE', 600_000);
      for (let n = 1; n <= 2; n++) expect(await inCloud(`${mark} №${n}`)).toBe(1);
    });

    test('the branch server loses power while it works alone', async ({ browser }) => {
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      await goOffline();
      const mark = `Отключение питания ${Date.now().toString(36)}`;
      await reply(page, `${mark} №1`);
      await reply(page, `${mark} №2`);
      await power(1, 'off');
      await power(1, 'on');
      // still without the line: the node works alone again, with what it had
      await expectMode(1, 'OFFLINE', 600_000);
      await reply(page, `${mark} №3`);
      link(1, 'up');
      await expectMode(1, 'ONLINE', 600_000);
      for (let n = 1; n <= 3; n++) expect(await inCloud(`${mark} №${n}`)).toBe(1);
    });

    test('the branch server loses power during the sync', async ({ browser }) => {
      await expectMode(1, 'ONLINE');
      const page = await student(browser);
      await goOffline();
      const mark = `Питание при синхронизации ${Date.now().toString(36)}`;
      for (let n = 1; n <= 4; n++) await reply(page, `${mark} №${n}`);
      link(1, 'up');
      await whenMode(1, 'SYNC');
      await power(1, 'off');
      await power(1, 'on');
      await expectMode(1, 'ONLINE', 900_000);
      for (let n = 1; n <= 4; n++) expect(await inCloud(`${mark} №${n}`)).toBe(1);
    });

    test('an outage longer than the cloud keeps WAL for: the node copies the database anew', async ({
      browser,
    }) => {
      // the cloud keeps little WAL for a silent node
      const env = '/opt/hubium/.env';
      onServer(cloudServer, [
        'sh',
        '-c',
        `sed -i '/^NODE_WAL_KEEP=/d' ${env} && echo NODE_WAL_KEEP=256MB >> ${env}`,
      ]);
      cloudCompose(['up', '-d', '--wait', 'db']);
      const slot = async () =>
        (
          await sql<{ s: string | null }>(
            `SELECT wal_status AS s FROM pg_replication_slots WHERE slot_name LIKE 'hubium_node_%'`,
          )
        )[0]?.s ?? null;
      try {
        await expectMode(1, 'ONLINE', 300_000);
        const page = await student(browser);
        await goOffline();
        const mark = `После долгого обрыва ${Date.now().toString(36)}`;
        await reply(page, mark);

        await sql(`DROP TABLE IF EXISTS lab_wal_filler`);
        await sql(
          `CREATE TABLE lab_wal_filler AS SELECT g, ${Array.from({ length: 12 }, () => 'md5(random()::text)').join(' || ')} AS x
           FROM generate_series(1, 500000) g`,
        );
        await sql(`SELECT pg_switch_wal()`);
        await expect
          .poll(
            async () => {
              await sql(`CHECKPOINT`);
              return slot();
            },
            { timeout: 120_000 },
          )
          .toBe('lost');
        await sql(`DROP TABLE lab_wal_filler`);

        link(1, 'up');
        await expectMode(1, 'ONLINE', 900_000);
        expect(await slot()).not.toBe('lost');
        expect(await inCloud(mark)).toBe(1);
      } finally {
        await sql(`DROP TABLE IF EXISTS lab_wal_filler`);
        onServer(cloudServer, ['sh', '-c', `sed -i '/^NODE_WAL_KEEP=/d' ${env}`]);
        cloudCompose(['up', '-d', '--wait', 'db']);
      }
    });
  });
