import {
  defaultSettings,
  enabledLocales,
  type MaintenanceState,
  maintenanceState,
  retryAfterSeconds,
  type SettingKey,
  settingDefs,
  siteLocale,
} from '@hubium/core';
import { fromAcceptLanguage } from '@hubium/i18n';
import { createTranslator } from '@hubium/i18n/packs';
import type { NextRequest } from 'next/server';
import { db } from './db';

// Maintenance mode at the edge of the app (proxy.ts): the state is read at most every few
// seconds, so turning it on or off from the CLI or another instance takes effect quickly.

const KEYS: SettingKey[] = [
  'maintenance.enabled',
  'maintenance.message',
  'maintenance.until',
  'site.name',
  'site.defaultLocale',
  'i18n.disabledLocales',
];
let cache: { at: number; settings: ReturnType<typeof defaultSettings> } | undefined;

async function settings() {
  if (cache && Date.now() - cache.at < 5_000) return cache.settings;
  const s = defaultSettings() as Record<string, unknown>;
  const rows = await db.siteSetting.findMany({ where: { key: { in: KEYS } } }).catch(() => []);
  for (const r of rows) {
    const parsed = settingDefs[r.key as SettingKey].safeParse(r.value);
    if (parsed.success) s[r.key] = parsed.data;
  }
  cache = { at: Date.now(), settings: s as ReturnType<typeof defaultSettings> };
  return cache.settings;
}

export async function currentMaintenance(): Promise<MaintenanceState> {
  return maintenanceState(await settings());
}

const adminUser = { isSiteAdmin: true, status: 'ACTIVE', deletedAt: null } as const;

/**
 * Whether the request's session belongs to an active site administrator, or is one's
 * "log in as" session (so that they can look around and come back).
 */
export async function isSiteAdminRequest(req: NextRequest): Promise<boolean> {
  const cookie = req.cookies.getAll().find((c) => c.name.endsWith('hubium.session_token'));
  // the cookie holds "<token>.<signature>"; the token alone finds the session
  const token = cookie ? decodeURIComponent(cookie.value).split('.')[0] : '';
  if (!token) return false;
  const session = await db.session
    .findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: { userId: true, impersonatedBy: true },
    })
    .catch(() => null);
  if (!session) return false;
  const admin = await db.user
    .count({
      where: {
        id: { in: [session.userId, session.impersonatedBy ?? session.userId] },
        ...adminUser,
      },
    })
    .catch(() => 0);
  return admin > 0;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The 503 answer: JSON for the API, a small page for everything else. */
export async function maintenanceResponse(req: NextRequest, m: MaintenanceState) {
  const s = await settings();
  const retry = String(retryAfterSeconds(m));
  const locale =
    fromAcceptLanguage(req.headers.get('accept-language'), enabledLocales(s)) ?? siteLocale(s);
  const t = createTranslator(locale, siteLocale(s));
  const message = m.message.trim() || t('maintenance.defaultMessage');
  const headers = { 'Retry-After': retry, 'Cache-Control': 'no-store' };
  if (req.nextUrl.pathname.startsWith('/api/'))
    return Response.json(
      { ok: false, code: 'MAINTENANCE', message, until: m.until?.toISOString() ?? null },
      { status: 503, headers },
    );
  const until = m.until
    ? t('maintenance.until', {
        time: new Intl.DateTimeFormat(locale, {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: 'UTC',
          timeZoneName: 'short',
        }).format(m.until),
      })
    : '';
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('maintenance.title'))} · ${esc(s['site.name'])}</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a}
main{max-width:32rem;margin:1rem;padding:2rem;border-radius:1rem;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{margin:0 0 .75rem;font-size:1.5rem}p{line-height:1.5;white-space:pre-line}small{color:#475569}a{color:#4338ca}
@media (prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}main{background:#1e293b}small{color:#94a3b8}a{color:#a5b4fc}}
</style>
</head>
<body>
<main>
<h1>${esc(t('maintenance.title'))}</h1>
<p>${esc(message)}</p>
${until ? `<p><small>${esc(until)}</small></p>` : ''}
<p><small><a href="/login">${esc(t('maintenance.adminSignIn'))}</a></small></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'`,
    },
  });
}
