import type { Db } from '@hubium/db';
import { decryptSecret, encryptSecret } from '../crypto.ts';

// APP_SECRET rotation: re-encrypts every secret envelope stored in the database with the
// new secret. Signed links (unsubscribe, content tokens, LTI hints) simply expire; the
// LTI platform key should be rotated from Admin → LTI afterwards.

export async function rotateAppSecret(db: Db, oldSecret: string, newSecret: string) {
  if (newSecret.length < 32) throw new Error('The new secret must be at least 32 characters');
  const re = (v: string) => encryptSecret(decryptSecret(v, oldSecret), newSecret);
  return db.$transaction(async (tx) => {
    let count = 0;
    for (const p of await tx.aiProvider.findMany({ where: { apiKeyEnc: { not: null } } })) {
      await tx.aiProvider.update({ where: { id: p.id }, data: { apiKeyEnc: re(p.apiKeyEnc!) } });
      count++;
    }
    for (const e of await tx.aiEmbeddingConfig.findMany({ where: { apiKeyEnc: { not: null } } })) {
      await tx.aiEmbeddingConfig.update({
        where: { id: e.id },
        data: { apiKeyEnc: re(e.apiKeyEnc!) },
      });
      count++;
    }
    return { reencrypted: count };
  });
}
