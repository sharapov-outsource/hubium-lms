import { expect, test } from '@playwright/test';
import { ADMIN, DEMO_PASSWORD, login } from '../tests/helpers';
import { certificateAt, contextAt, expectMode } from './helpers';
import { branchIp, CLOUD_IP, installNode, startBranch } from './lab';

// The cloud's administrator adds the branch's node and installs it on the branch's server
// with the command the cloud shows; a wrong code installs nothing. The node copies the
// cloud's database, then serves the branch's network under the cloud's names.

test('a node is added in the cloud and installed with its code', async ({ page }) => {
  const cloud = await contextAt('cloud');
  try {
    const admin = await cloud.newPage();
    await login(admin, ADMIN.login, ADMIN.password);
    await admin.goto('/admin/nodes');
    await admin.getByLabel('Название').fill('Филиал 1');
    await admin.getByRole('button', { name: 'Добавить узел' }).click();
    const command = (await admin.getByTestId('node-install').textContent()) ?? '';
    expect(command).toContain('--hub https://lms.test');
    const code = /--code (\S+)/.exec(command)?.[1] ?? '';
    expect(code).not.toBe('');

    await startBranch(1);
    expect(() => installNode(1, 'not-a-code')).toThrow(/did not register/);
    installNode(1, code);
    await expectMode(1, 'ONLINE', 900_000);

    // the cloud learns it from the node's next heartbeat
    await expect
      .poll(
        async () => {
          await admin.goto('/admin/nodes');
          return admin.getByRole('row', { name: /Филиал 1/ }).textContent();
        },
        { timeout: 120_000, intervals: [5000] },
      )
      .toContain('На связи');
  } finally {
    await cloud.close();
  }

  // the node answers with the cloud's certificate (it fetches it from the cloud)
  const cloudCert = await certificateAt(CLOUD_IP);
  await expect
    .poll(() => certificateAt(branchIp(1)).catch(() => null), {
      timeout: 120_000,
      intervals: [3000],
    })
    .toEqual(cloudCert);
  expect(cloudCert.authorized).toBe(true);

  // the branch's people work through it under the cloud's name
  await login(page, 'student1', DEMO_PASSWORD);
  await expect(page.getByRole('link', { name: /Python для начинающих/ }).first()).toBeVisible();
});
