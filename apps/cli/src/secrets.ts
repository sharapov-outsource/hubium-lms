import { rotateAppSecret } from '@hubium/core/security/rotate';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { withDb } from './system.ts';

/** `hubium secrets rotate`: re-encrypts what is stored with OLD_APP_SECRET under APP_SECRET. */
export async function secretsCommand(args: string[], io: Io): Promise<number> {
  if (args[0] !== 'rotate') throw new UsageError('Usage: hubium secrets rotate');
  const oldSecret = process.env.OLD_APP_SECRET;
  const newSecret = process.env.APP_SECRET;
  if (!oldSecret || !newSecret || oldSecret === newSecret)
    throw new UsageError('Set OLD_APP_SECRET (the previous value) and APP_SECRET (the new one).');
  return withDb(async (db) => {
    const r = await rotateAppSecret(db, oldSecret, newSecret);
    io.out(`Re-encrypted ${r.reencrypted} secret(s). Rotate the LTI platform key in Admin → LTI.`);
    return 0;
  });
}
