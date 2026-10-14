import type { Db } from '@hubium/db';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { decryptSecret, encryptSecret } from '../crypto.ts';

// APP_SECRET rotation: re-encrypts every secret envelope stored in the database with the
// new secret (AI keys, webhook signing secrets, SSO client secrets and signing keys, the LDAP service password), including the TOTP secrets better-auth encrypts with it (otherwise every
// two-factor user would be locked out). Signed links (unsubscribe, content tokens, LTI
// hints) simply expire; the LTI platform key should be rotated from Admin → LTI afterwards.

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
    for (const w of await tx.webhook.findMany({ select: { id: true, secretEnc: true } })) {
      await tx.webhook.update({ where: { id: w.id }, data: { secretEnc: re(w.secretEnc) } });
      count++;
    }
    for (const p of await tx.ssoProvider.findMany()) {
      if (!p.clientSecretEnc && !p.spPrivateKeyEnc) continue;
      await tx.ssoProvider.update({
        where: { id: p.id },
        data: {
          clientSecretEnc: p.clientSecretEnc && re(p.clientSecretEnc),
          spPrivateKeyEnc: p.spPrivateKeyEnc && re(p.spPrivateKeyEnc),
        },
      });
      count++;
    }
    for (const l of await tx.ldapServer.findMany({ where: { bindPasswordEnc: { not: null } } })) {
      await tx.ldapServer.update({
        where: { id: l.id },
        data: { bindPasswordEnc: re(l.bindPasswordEnc!) },
      });
      count++;
    }
    for (const t of await tx.twoFactor.findMany({ select: { id: true, secret: true } })) {
      const plain = await symmetricDecrypt({ key: oldSecret, data: t.secret });
      await tx.twoFactor.update({
        where: { id: t.id },
        data: { secret: await symmetricEncrypt({ key: newSecret, data: plain }) },
      });
      count++;
    }
    return { reencrypted: count };
  });
}
