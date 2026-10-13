import { beforeAll, describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { withActorScope } from '../events/actor-scope.ts';
import { logEvent } from '../events/log.ts';
import { createAuth } from './auth.ts';
import { loginAsDenial } from './login-as.ts';

/** A minimal cookie jar: applies Set-Cookie headers, dropping expired cookies. */
function applyCookies(jar: Map<string, string>, headers: Headers) {
  for (const line of headers.getSetCookie()) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (expired) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1));
  }
  return new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
}

describe('log in as', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    for (const u of await t.db.user.findMany({ select: { id: true, email: true } }))
      ids[u.email.split('@')[0]!] = u.id;
  });

  it('needs user:loginas, and only an administrator may become another administrator', async () => {
    expect(await loginAsDenial(t.db, ids.manager!, ids.student1!)).toBeNull();
    expect(await loginAsDenial(t.db, ids.admin!, ids.manager!)).toBeNull();
    expect(await loginAsDenial(t.db, ids.teacher!, ids.student1!)).toMatch(/not allowed/);
    expect(await loginAsDenial(t.db, ids.manager!, ids.admin!)).toMatch(/administrator/);
    expect(await loginAsDenial(t.db, ids.manager!, ids.manager!)).toMatch(/already/);
    await t.db.user.update({ where: { id: ids.student2! }, data: { status: 'SUSPENDED' } });
    try {
      expect(await loginAsDenial(t.db, ids.manager!, ids.student2!)).toMatch(/suspended/);
    } finally {
      await t.db.user.update({ where: { id: ids.student2! }, data: { status: 'ACTIVE' } });
    }
  });

  it('switches the session to the user and back, recording who really acted', async () => {
    const jar = new Map<string, string>();
    const signIn = await auth.api.signInEmail({
      body: { email: 'manager@hubium.local', password: 'Demo12345!' },
      returnHeaders: true,
    });
    let cookie = applyCookies(jar, signIn.headers);

    const as = await auth.api.loginAs({
      body: { userId: ids.student1! },
      headers: cookie,
      returnHeaders: true,
    });
    cookie = applyCookies(jar, as.headers);
    const session = await auth.api.getSession({ headers: cookie });
    expect(session?.user.id).toBe(ids.student1);
    expect(session?.session.impersonatedBy).toBe(ids.manager);
    const login = await t.db.user.findUniqueOrThrow({ where: { id: ids.student1! } });
    expect(login.lastLoginAt).toBeNull();

    // the student's credentials stay theirs
    await expect(
      auth.api.changeEmail({ body: { newEmail: 'someone@example.org' }, headers: cookie }),
    ).rejects.toMatchObject({ statusCode: 403 });
    // and a second "log in as" needs a return first
    await expect(
      auth.api.loginAs({ body: { userId: ids.student2! }, headers: cookie }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await withActorScope(
      { kind: 'user', userId: ids.student1!, isSiteAdmin: false, realUserId: ids.manager! },
      () => logEvent(t.db, { name: 'test.acted', actorId: ids.student1! }),
    );
    const acted = await t.db.eventLog.findFirstOrThrow({ where: { name: 'test.acted' } });
    expect(acted).toMatchObject({ actorId: ids.student1, realActorId: ids.manager });
    const started = await t.db.eventLog.findFirstOrThrow({ where: { name: 'user.loggedinas' } });
    expect(started).toMatchObject({ actorId: ids.manager, relatedUserId: ids.student1 });

    const back = await auth.api.stopImpersonating({ headers: cookie, returnHeaders: true });
    cookie = applyCookies(jar, back.headers);
    const restored = await auth.api.getSession({ headers: cookie });
    expect(restored?.user.id).toBe(ids.manager);
    expect(restored?.session.impersonatedBy).toBeFalsy();
  });

  it("keeps the admin plugin's own user management closed", async () => {
    await expect(auth.api.listUsers({ query: {} })).rejects.toMatchObject({ statusCode: 404 });
  });
});
