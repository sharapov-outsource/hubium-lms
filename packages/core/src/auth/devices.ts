import { isIP } from 'node:net';
import type { Db } from '@hubium/db';
import { log } from '@hubium/log';
import { sha256Hex, sign, verifySignature } from '../crypto.ts';
import { getEnv } from '../env.ts';
import { logEvent } from '../events/log.ts';
import { notifyUsers, registerNotificationType } from '../notifications/notifications.ts';
import { getAllSettings } from '../settings/settings.ts';

const logger = log('auth');

// "New sign-in" notices. A device is a browser and OS on a network (IPv4 /16, IPv6 /32),
// so moving between Wi-Fi and mobile data in one city rarely counts as new. The first
// device a user is seen on is recorded silently; each later new one is notified through
// the `auth.newSignIn` notification type, which users can switch off like any other.

export const NEW_SIGN_IN = 'auth.newSignIn';
registerNotificationType(NEW_SIGN_IN, { email: 'IMMEDIATE' });

const NOT_ME = 'not-me';
const NOT_ME_DAYS = 7;

/** "Chrome · Windows" from a User-Agent header. */
export function deviceLabel(ua: string | null | undefined, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /YaBrowser/.test(ua)
      ? 'Yandex Browser'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : unknown;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}

/** The network part of an address: IPv4 /16, IPv6 /32. */
export function networkPrefix(ip: string | null | undefined): string {
  if (!ip) return '';
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return v4.split('.').slice(0, 2).join('.');
  if (isIP(ip) === 6) {
    const [head = '', tail = ''] = ip.split('::');
    const groups = [...head.split(':'), ...Array(8).fill('0'), ...tail.split(':')].filter(
      (g) => g !== '',
    );
    return groups.slice(0, 2).join(':').toLowerCase();
  }
  return '';
}

export function deviceFingerprint(ua: string | null | undefined, ip: string | null | undefined) {
  return sha256Hex(`${deviceLabel(ua, '?')}|${networkPrefix(ip)}`);
}

/**
 * Records a sign-in. Notifies the user when the device is new and not their first one.
 * Never throws: a failed notice must not fail the sign-in.
 */
export async function noteSignIn(
  db: Db,
  s: { userId: string; userAgent?: string | null; ipAddress?: string | null },
): Promise<void> {
  try {
    const fingerprint = deviceFingerprint(s.userAgent, s.ipAddress);
    const label = deviceLabel(s.userAgent, '—');
    const known = await db.knownDevice.findUnique({
      where: { userId_fingerprint: { userId: s.userId, fingerprint } },
    });
    if (known) {
      await db.knownDevice.update({
        where: { id: known.id },
        data: { lastSeenAt: new Date(), lastIp: s.ipAddress ?? null },
      });
      return;
    }
    const hadOthers = (await db.knownDevice.count({ where: { userId: s.userId } })) > 0;
    const device = await db.knownDevice.create({
      data: { userId: s.userId, fingerprint, label, lastIp: s.ipAddress ?? null },
    });
    if (!hadOthers || !(await getAllSettings(db))['auth.newSignInNotice']) return;
    const ip = s.ipAddress ?? '—';
    await db.$transaction((tx) =>
      notifyUsers(tx, [s.userId], {
        type: NEW_SIGN_IN,
        title: { key: 'notifications.newSignIn.title' },
        body: { key: 'notifications.newSignIn.body', values: { device: label, ip } },
        url: `/not-me?token=${notMeToken(s.userId, device.id)}`,
        data: { deviceId: device.id, ip },
      }),
    );
  } catch (err) {
    logger.error({ err, userId: s.userId }, 'new sign-in notice failed');
  }
}

/** Signed link from the notice; valid for a week. */
export function notMeToken(userId: string, deviceId: string, now = new Date()): string {
  const exp = Math.floor(now.getTime() / 1000) + NOT_ME_DAYS * 86_400;
  const value = Buffer.from(`${userId}:${deviceId}:${exp}`).toString('base64url');
  return `${value}.${sign(value, getEnv().APP_SECRET, NOT_ME)}`;
}

export function parseNotMeToken(
  token: string,
  now = new Date(),
): { userId: string; deviceId: string } | null {
  const [value, sig] = token.split('.');
  if (!value || !sig || !verifySignature(value, sig, getEnv().APP_SECRET, NOT_ME)) return null;
  const [userId, deviceId, exp] = Buffer.from(value, 'base64url').toString('utf8').split(':');
  if (!userId || !deviceId || Number(exp) * 1000 < now.getTime()) return null;
  return { userId, deviceId };
}

/** What the "it wasn't me" page shows. Null once the link was used or has expired. */
export async function notMeDetails(db: Db, token: string) {
  const t = parseNotMeToken(token);
  if (!t) return null;
  return db.knownDevice.findFirst({
    where: { id: t.deviceId, userId: t.userId },
    select: { label: true, lastIp: true, firstSeenAt: true },
  });
}

/**
 * "It wasn't me": forgets the device and ends every session of the user. Returns the
 * account's email so the caller can send a password reset (Better Auth does that).
 */
export async function reportNotMe(db: Db, token: string): Promise<{ email: string | null } | null> {
  const t = parseNotMeToken(token);
  if (!t) return null;
  const device = await db.knownDevice.findFirst({ where: { id: t.deviceId, userId: t.userId } });
  if (!device) return null;
  await db.knownDevice.delete({ where: { id: device.id } });
  await db.session.deleteMany({ where: { userId: t.userId } });
  const user = await db.user.findUniqueOrThrow({
    where: { id: t.userId },
    select: { email: true, emailPlaceholder: true },
  });
  await logEvent(db, {
    name: 'user.signInReported',
    actorId: t.userId,
    relatedUserId: t.userId,
    objectType: 'user',
    objectId: t.userId,
    data: { device: device.label, ip: device.lastIp },
  });
  return { email: user.emailPlaceholder ? null : user.email };
}
