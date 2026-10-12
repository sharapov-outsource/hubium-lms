// Usage: OLD_APP_SECRET=<current> APP_SECRET=<new> pnpm --filter @hubium/core secrets:rotate
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const { createDb } = await import('@hubium/db');
const { rotateAppSecret } = await import('../src/security/rotate.ts');

const oldSecret = process.env.OLD_APP_SECRET;
const newSecret = process.env.APP_SECRET;
if (!oldSecret || !newSecret || oldSecret === newSecret) {
  console.error('Set OLD_APP_SECRET (current) and APP_SECRET (new, different).');
  process.exit(1);
}
const db = createDb();
const r = await rotateAppSecret(db, oldSecret, newSecret);
console.log(`Re-encrypted ${r.reencrypted} secret(s). Rotate the LTI platform key in Admin → LTI.`);
await db.$disconnect();
