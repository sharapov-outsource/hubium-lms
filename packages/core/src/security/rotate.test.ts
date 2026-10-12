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
    const next = 'n'.repeat(40);
    const r = await rotateAppSecret(t.db, getEnv().APP_SECRET, next);
    expect(r.reencrypted).toBeGreaterThanOrEqual(1);
    const row = await t.db.aiProvider.findUniqueOrThrow({ where: { id } });
    expect(decryptSecret(row.apiKeyEnc!, next)).toBe('sk-ant-rotate-me');
    expect(() => decryptSecret(row.apiKeyEnc!, getEnv().APP_SECRET)).toThrow();
    await expect(rotateAppSecret(t.db, next, 'short')).rejects.toThrow(/32/);
    // restore for other tests
    await rotateAppSecret(t.db, next, getEnv().APP_SECRET);
  });
});
