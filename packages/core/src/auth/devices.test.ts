import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { setSettings } from '../settings/settings.ts';
import { createUser } from '../users/users.ts';
import { createAuth } from './auth.ts';
import {
  deviceLabel,
  NEW_SIGN_IN,
  networkPrefix,
  notMeDetails,
  parseNotMeToken,
  reportNotMe,
} from './devices.ts';

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

describe('device helpers', () => {
  it('labels browsers and systems', () => {
    expect(deviceLabel(CHROME_WIN, '?')).toBe('Chrome · Windows');
    expect(deviceLabel(FIREFOX_LINUX, '?')).toBe('Firefox · Linux');
    expect(deviceLabel(null, '?')).toBe('?');
  });
  it('keeps the network part of an address', () => {
    expect(networkPrefix('203.0.113.7')).toBe('203.0');
    expect(networkPrefix('::ffff:198.51.100.4')).toBe('198.51');
    expect(networkPrefix('2001:db8:1:2::5')).toBe('2001:db8');
    expect(networkPrefix('::1')).toBe('0:0');
    expect(networkPrefix(undefined)).toBe('');
  });
});

describe('new sign-in notices', () => {
  const t = useTestDb();
  let auth: ReturnType<typeof createAuth>;
  let userId: string;

  beforeAll(async () => {
    auth = createAuth({ db: t.db, baseURL: 'http://lms.test', secret: 's'.repeat(40) });
    ({ id: userId } = await createUser.run(await ctxFor(t.db, 'admin@test.local'), {
      email: 'device@example.org',
      firstName: 'De',
      lastName: 'Vice',
      password: 'Device-pass-1',
    }));
  });
  afterEach(() => setSettings(t.db, { 'auth.newSignInNotice': true }));

  const signIn = (ua: string, ip: string) =>
    auth.api.signInEmail({
      body: { email: 'device@example.org', password: 'Device-pass-1' },
      headers: new Headers({ 'user-agent': ua, 'x-forwarded-for': ip }),
    });
  const notices = () => t.db.notification.findMany({ where: { userId, type: NEW_SIGN_IN } });

  it('records the first device silently and notifies of later new ones', async () => {
    await signIn(CHROME_WIN, '203.0.113.7');
    expect(await notices()).toHaveLength(0);
    // the same browser on a nearby address is the same device
    await signIn(CHROME_WIN, '203.0.200.9');
    expect(await notices()).toHaveLength(0);
    await signIn(FIREFOX_LINUX, '198.51.100.4');
    const [n] = await notices();
    expect(n!.body).toContain('Firefox · Linux');
    expect(n!.body).toContain('198.51.100.4');

    await setSettings(t.db, { 'auth.newSignInNotice': false });
    await signIn(FIREFOX_LINUX, '192.0.2.1');
    expect(await notices()).toHaveLength(1);
  });

  it('"it wasn\'t me" ends every session once', async () => {
    const [n] = await notices();
    const token = new URL(n!.url!, 'http://x').searchParams.get('token')!;
    expect(parseNotMeToken(`${token}x`)).toBeNull();
    expect(parseNotMeToken(token, new Date(Date.now() + 8 * 86_400_000))).toBeNull();
    expect(await notMeDetails(t.db, token)).toMatchObject({ label: 'Firefox · Linux' });
    expect(await t.db.session.count({ where: { userId } })).toBeGreaterThan(0);

    expect(await reportNotMe(t.db, token)).toEqual({ email: 'device@example.org' });
    expect(await t.db.session.count({ where: { userId } })).toBe(0);
    expect(await reportNotMe(t.db, token)).toBeNull();
    expect(
      await t.db.eventLog.count({ where: { name: 'user.signInReported', relatedUserId: userId } }),
    ).toBe(1);
  });
});
