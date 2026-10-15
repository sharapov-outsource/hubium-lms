import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { saveAiProvider } from '../ai/config.ts';
import { decryptSecret } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { rotateAppSecret } from './rotate.ts';

describe('APP_SECRET rotation', () => {
  const t = useTestDb();

  it('re-encrypts stored provider keys with the new secret', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await saveAiProvider.run(admin, {
      kind: 'ANTHROPIC',
      name: 'rot',
      apiKey: 'sk-ant-rotate-me',
      models: { generation: 'a', cheap: 'b', premium: 'c' },
    });
    const student = await t.db.user.findFirstOrThrow({ where: { username: 'student1' } });
    const tf = await t.db.twoFactor.create({
      data: {
        userId: student.id,
        secret: await symmetricEncrypt({ key: getEnv().APP_SECRET, data: 'TOTPSECRET' }),
        // stored as Better Auth stores them: encrypted with the same secret
        backupCodes: await symmetricEncrypt({
          key: getEnv().APP_SECRET,
          data: JSON.stringify(['AAAAA-11111', 'BBBBB-22222']),
        }),
      },
    });
    const next = 'n'.repeat(40);
    const r = await rotateAppSecret(t.db, getEnv().APP_SECRET, next);
    expect(r.reencrypted).toBeGreaterThanOrEqual(1);
    const row = await t.db.aiProvider.findUniqueOrThrow({ where: { id } });
    expect(decryptSecret(row.apiKeyEnc!, next)).toBe('sk-ant-rotate-me');
    expect(() => decryptSecret(row.apiKeyEnc!, getEnv().APP_SECRET)).toThrow();
    const tf2 = await t.db.twoFactor.findUniqueOrThrow({ where: { id: tf.id } });
    expect(await symmetricDecrypt({ key: next, data: tf2.secret })).toBe('TOTPSECRET');
    // the backup codes still work after the rotation: someone who lost their phone can sign in
    expect(JSON.parse(await symmetricDecrypt({ key: next, data: tf2.backupCodes }))).toEqual([
      'AAAAA-11111',
      'BBBBB-22222',
    ]);
    await expect(rotateAppSecret(t.db, next, 'short')).rejects.toThrow(/32/);
    // restore for other tests
    await rotateAppSecret(t.db, next, getEnv().APP_SECRET);
    await t.db.twoFactor.delete({ where: { id: tf.id } });
  });
});
