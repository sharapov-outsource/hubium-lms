import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Operations take their time from ctx.now (opNow below an operation) and their random
// numbers from ctx.random (opRandom), so that the cloud replaying an operation a local node
// ran gets the values the node had (docs/PLAN.md). The clock and Math.random stay where they
// decide nothing an operation stores: expiries of links, tokens and uploads, timing and
// rate limits, the worker's schedules and housekeeping, sign-in bookkeeping, exchanges with
// other servers and reads ("is it open now?"). These are the calls of each file; a new one
// needs that reason, and a file that drops one lowers its number.

const ALLOWED: Record<string, number> = {
  'modules/forum/src/server.ts': 1,
  'modules/livesession/src/providers.ts': 1,
  'modules/lti/src/protocol.ts': 5,
  'modules/lti/src/server.ts': 3,
  'modules/quiz/src/server.ts': 1,
  'modules/video/src/server.ts': 3,
  'packages/core/src/access/permissions.ts': 2,
  'packages/core/src/ai/indexing.ts': 1,
  'packages/core/src/ai/quizgen.ts': 1,
  'packages/core/src/ai/tutor.ts': 3,
  'packages/core/src/ai/usage.ts': 5,
  'packages/core/src/ai/user-ctx.ts': 1,
  'packages/core/src/announcements/announcements.ts': 3,
  'packages/core/src/api-tokens/tokens.ts': 1,
  'packages/core/src/auth/auth.ts': 2,
  'packages/core/src/auth/devices.ts': 3,
  'packages/core/src/auth/ldap.ts': 3,
  'packages/core/src/auth/lockout.ts': 3,
  'packages/core/src/auth/login-as.ts': 1,
  'packages/core/src/auth/password-policy.ts': 2,
  'packages/core/src/auth/recovery.ts': 3,
  'packages/core/src/auth/saml-keys.ts': 1,
  'packages/core/src/badges/badges.ts': 2,
  'packages/core/src/calendar/calendar.ts': 4,
  'packages/core/src/calendar/subscriptions.ts': 2,
  'packages/core/src/certificates/certificates.ts': 1,
  'packages/core/src/competencies/plans.ts': 1,
  'packages/core/src/completion/completion.ts': 1,
  'packages/core/src/content.ts': 2,
  'packages/core/src/courses/courses.ts': 1,
  'packages/core/src/courses/file-access.ts': 1,
  'packages/core/src/courses/recyclebin.ts': 1,
  'packages/core/src/enrol/enrol.ts': 1,
  'packages/core/src/enrol/participants.ts': 1,
  'packages/core/src/events/prune.ts': 1,
  'packages/core/src/files/files.ts': 6,
  'packages/core/src/files/storage.ts': 3,
  'packages/core/src/files/text.ts': 1,
  'packages/core/src/files/uploads.ts': 7,
  'packages/core/src/grades/gradebook.ts': 3,
  'packages/core/src/notifications/notifications.ts': 2,
  'packages/core/src/notifications/push.ts': 1,
  'packages/core/src/reports/reports.ts': 2,
  'packages/core/src/system/health.ts': 3,
  'packages/core/src/system/maintenance.ts': 1,
  'packages/core/src/touch/touch.ts': 1,
  'packages/core/src/users/last-access.ts': 1,
  'packages/core/src/users/relations.ts': 1,
  'packages/core/src/webhooks/webhooks.ts': 5,
};

const root = path.resolve(import.meta.dirname, '../../..');
const CALL = /new Date\(\)|Date\.now\(\)|Math\.random\(\)/g;

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.includes('.test.'))
    .map((e) => path.relative(root, path.join(e.parentPath, e.name)))
    .filter((f) => !f.includes('/ui/') && !f.includes('/seed/'));
}

describe('the clock and Math.random in operations', () => {
  it('are called only where they decide nothing an operation stores', () => {
    const modules = readdirSync(path.join(root, 'modules')).map((m) => `modules/${m}/src`);
    const found: Record<string, number> = {};
    for (const f of [...sources('packages/core/src'), ...modules.flatMap(sources)]) {
      const n = readFileSync(path.join(root, f), 'utf8').match(CALL)?.length ?? 0;
      if (n) found[f] = n;
    }
    expect(found).toEqual(ALLOWED);
  });
});
