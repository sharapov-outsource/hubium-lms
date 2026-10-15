import { enabledLocales, getAllSettings, siteLocale, zoneOr } from '@hubium/core';
import { LOCALE_COOKIE, resolveLocale } from '@hubium/i18n';
import { messagesFor } from '@hubium/i18n/packs';
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';

const COURSE_PATH = /^\/course\/([0-9a-f-]{36})(?:\/|$)/;

// next-intl without locale-prefixed routes. The language comes from the course's forced
// language, the user's profile, the cookie, the browser (when the site allows it) and the
// site language, among the enabled language packs. Messages fall back to the site language
// and then to English string by string.
export default getRequestConfig(async () => {
  const [user, cookieStore, h, settings] = await Promise.all([
    getCurrentUser().catch(() => null),
    cookies(),
    headers(),
    getAllSettings(db),
  ]);
  // the proxy passes the page path; course pages may force their language
  const courseId = h.get('x-hubium-path')?.match(COURSE_PATH)?.[1];
  const course = courseId
    ? await db.course.findUnique({ where: { id: courseId }, select: { lang: true } })
    : null;
  const site = siteLocale(settings);
  const locale = resolveLocale({
    course: course?.lang,
    user: user?.locale,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: h.get('accept-language'),
    site,
    enabled: enabledLocales(settings),
    detectBrowser: settings['i18n.detectBrowser'],
  });
  return {
    locale,
    messages: messagesFor(locale, site),
    // a zone stored before zones were checked would break every date on the page
    timeZone: zoneOr(user?.timezone, settings['site.defaultTimezone']),
  };
});
