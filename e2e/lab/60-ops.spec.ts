import { expect, type Page, test } from '@playwright/test';
import { demoCourse } from '../node/helpers';
import { sql } from '../tests/db';
import { ADMIN, DEMO_PASSWORD, login } from '../tests/helpers';
import { contextAt, expectMode } from './helpers';
import {
  agentState,
  cloudCompose,
  cloudServer,
  DOMAIN,
  installNode,
  LMS,
  link,
  nodeCommand,
  nodeCompose,
  onServer,
} from './lab';

// Running a branch's node: its administrator (named in the cloud) takes it off the line
// before an exam on the node's page and brings it back, and puts the sync off from the
// command line when the line goes during a lesson; the cloud measures its nodes; a node is
// installed anew with a new code; a revoked node gets nothing more from the cloud.

async function nodeId(name = 'Филиал 1') {
  const [n] = await sql<{ id: string; dbRole: string }>(
    `SELECT id, "dbRole" FROM "Node" WHERE name = $1 AND "revokedAt" IS NULL`,
    [name],
  );
  return n!;
}

async function post(page: Page, text: string) {
  const ids = await demoCourse();
  const [d] = await sql<{ id: string }>(
    `SELECT id FROM "ForumDiscussion" WHERE "activityId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [ids.forumId],
  );
  await page.goto(`/course/${ids.courseId}/a/${ids.forumId}?d=${d!.id}`);
  await page.getByRole('button', { name: 'Ответить' }).first().click();
  await page.locator('[id^="msg-"]').first().click();
  await page.keyboard.type(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
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

async function cloudAdmin() {
  const context = await contextAt('cloud');
  const page = await context.newPage();
  await login(page, ADMIN.login, ADMIN.password);
  return { context, page };
}

test.describe
  .serial('running a branch', () => {
    test.setTimeout(1_800_000);

    test('the node admin takes the node off the line and puts the sync off', async ({ page }) => {
      await expectMode(1, 'ONLINE', 300_000);
      const node = await nodeId();
      await sql(`DELETE FROM "NodeAdmin" WHERE "nodeId" = $1`, [node.id]);
      const cloud = await cloudAdmin();
      await cloud.page.goto(`/admin/nodes/${node.id}`);
      await cloud.page.locator('#ctx-role-q').fill('teacher');
      await cloud.page
        .getByRole('button', { name: /^Назначить роль:/ })
        .first()
        .click();
      await expect
        .poll(
          async () =>
            (await sql(`SELECT 1 FROM "NodeAdmin" WHERE "nodeId" = $1`, [node.id])).length,
        )
        .toBe(1);
      await cloud.context.close();

      // before an exam on a poor line: the node works alone, with the line up, as its admin
      // asked, until they bring it back
      await login(page, 'teacher', DEMO_PASSWORD);
      await page.goto('/node');
      await expect(page.getByRole('heading', { name: 'Этот узел' })).toBeVisible();
      await page.getByRole('button', { name: 'Работать без основного сервера сейчас' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
      await expectMode(1, 'OFFLINE', 120_000);
      const exam = `Перед экзаменом ${Date.now().toString(36)}`;
      await post(page, exam);
      await page.goto('/node');
      await page.getByRole('button', { name: 'Вернуться к основному серверу' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
      await expectMode(1, 'ONLINE', 600_000);
      expect(await inCloud(exam)).toBe(1);

      // the line goes during a lesson: the sync waits until the lesson ends, then goes
      try {
        link(1, 'down');
        await expectMode(1, 'OFFLINE', 300_000);
        const lesson = `На занятии ${Date.now().toString(36)}`;
        await post(page, lesson);
        nodeCommand(1, ['postpone', '--until', new Date(Date.now() + 90_000).toISOString()]);
        await page.goto('/node');
        await expect(page.getByText(/Синхронизация ждёт до/)).toBeVisible();
        link(1, 'up');
        await new Promise((ok) => setTimeout(ok, 30_000));
        expect(agentState(1).mode).toBe('OFFLINE');
        expect(await inCloud(lesson)).toBe(0);
        await expectMode(1, 'ONLINE', 600_000);
        expect(await inCloud(lesson)).toBe(1);
      } finally {
        link(1, 'up');
      }
    });

    test('the cloud measures its nodes', async () => {
      const env = '/opt/hubium/.env';
      onServer(cloudServer, [
        'sh',
        '-c',
        `sed -i '/^METRICS_TOKEN=/d' ${env} && echo METRICS_TOKEN=lab-metrics >> ${env}`,
      ]);
      cloudCompose(['up', '-d', '--wait', 'web']);
      const metrics = onServer(cloudServer, [
        'curl',
        '-fsk',
        '--resolve',
        `${DOMAIN}:443:127.0.0.1`,
        '-H',
        'authorization: Bearer lab-metrics',
        `${LMS}/api/metrics`,
      ]);
      expect(metrics).toMatch(/hubium_node_mode\{[^}]*Филиал 1[^}]*mode="ONLINE"\} 1/);
      expect(metrics).toMatch(/hubium_node_heartbeat_age_seconds\{[^}]*Филиал 1[^}]*\} \d+/);
      expect(metrics).toMatch(/hubium_node_replica_lag_bytes\{[^}]*Филиал 1/);
    });

    test('a node installed anew with a new code', async ({ page }) => {
      await expectMode(1, 'ONLINE', 300_000);
      const before = await nodeId();
      const [old] = await sql<{ tokenHash: string }>(
        `SELECT "tokenHash" FROM "Node" WHERE id = $1`,
        [before.id],
      );
      const cloud = await cloudAdmin();
      await cloud.page.goto(`/admin/nodes/${before.id}`);
      await cloud.page.getByRole('button', { name: 'Новый код для переустановки' }).click();
      const confirm = cloud.page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      const command = (await cloud.page.getByTestId('node-install').textContent()) ?? '';
      const code = /--code (\S+)/.exec(command)?.[1] ?? '';
      expect(code).not.toBe('');
      await cloud.context.close();

      // a new disk: nothing of the old installation is left
      nodeCompose(1, ['down', '-v']);
      onServer('lab-branch1', ['rm', '-rf', '/opt/hubium/node']);
      installNode(1, code);
      await expectMode(1, 'ONLINE', 900_000);
      const [now] = await sql<{ tokenHash: string; n: number }>(
        `SELECT "tokenHash", (SELECT count(*)::int FROM "Node" WHERE name = 'Филиал 1') AS n
         FROM "Node" WHERE id = $1`,
        [before.id],
      );
      expect(now?.n).toBe(1);
      expect(now?.tokenHash).not.toBe(old?.tokenHash);
      await login(page, 'student1', DEMO_PASSWORD);
      await expect(page.getByRole('link', { name: /Python для начинающих/ }).first()).toBeVisible();
    });

    test('a revoked node gets nothing more from the cloud', async () => {
      const node = await nodeId();
      const cloud = await cloudAdmin();
      await cloud.page.goto(`/admin/nodes/${node.id}`);
      await cloud.page.getByRole('button', { name: 'Отозвать' }).click();
      await cloud.page.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();
      await expect(cloud.page.getByText('Узел отозван').first()).toBeVisible();
      await cloud.context.close();
      const [slot] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = $1`,
        [node.dbRole],
      );
      expect(slot?.n).toBe(0);
      const [role] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`,
        [node.dbRole],
      );
      expect(role?.n).toBe(0);
      // the node's calls are refused: it passes nothing on any more
      await expect
        .poll(
          () => {
            try {
              return agentState(1).mode;
            } catch {
              return '?';
            }
          },
          { timeout: 300_000, intervals: [3000] },
        )
        .not.toBe('ONLINE');
    });
  });
