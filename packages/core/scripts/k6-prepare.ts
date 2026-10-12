// Creates N load-test students enrolled in DEMO-PY with read+write API tokens and writes
// tools/k6/users.json:  pnpm --filter @hubium/core k6:prepare 1000
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });
const { createDb } = await import('@hubium/db');
const core = await import('../src/index.ts');

const n = Number(process.argv[2] ?? 100);
const db = createDb();
const sys = {
  db,
  actor: { kind: 'system' as const },
  perm: new core.Permissions(db, { kind: 'system' }),
  now: new Date(),
  locale: 'ru' as const,
  origin: 'CLI' as const,
};
const course = await db.course.findUniqueOrThrow({ where: { shortName: 'DEMO-PY' } });
const student = await db.role.findFirstOrThrow({ where: { shortName: 'student' } });
const out: { username: string; token: string }[] = [];
for (let i = 1; i <= n; i++) {
  const username = `load${String(i).padStart(4, '0')}`;
  let u = await db.user.findUnique({ where: { username } });
  if (!u) {
    const { id } = await core.createUser.run(sys, {
      username,
      email: `${username}@load.invalid`,
      firstName: 'Load',
      lastName: String(i),
      password: 'Load12345!',
    });
    u = await db.user.findUniqueOrThrow({ where: { id } });
  }
  await core.enrolUsers.run(sys, { courseId: course.id, userIds: [u.id], roleId: student.id }).catch(() => {});
  const ctx = { ...sys, actor: { kind: 'user' as const, userId: u.id, isSiteAdmin: false }, perm: new core.Permissions(db, await core.loadUserAccess(db, u)) };
  const t = await core.createApiToken(ctx, { name: 'k6', scopes: ['read', 'write'], expiresInDays: 7 });
  out.push({ username, token: t.token });
}
writeFileSync(path.resolve(import.meta.dirname, '../../../tools/k6/users.json'), JSON.stringify(out));
console.log(`Wrote ${out.length} users to tools/k6/users.json`);
await db.$disconnect();
