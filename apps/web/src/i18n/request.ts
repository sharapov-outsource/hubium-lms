import { getAllSettings } from '@hubium/core';
import { LOCALE_COOKIE, messages, resolveLocale } from '@hubium/i18n';
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { moduleMessages } from '@/modules/messages';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';

// next-intl without locale-prefixed routes: locale comes from the user profile, cookie,
// site default, then Accept-Language.
export default getRequestConfig(async () => {
  const [user, cookieStore, h, settings] = await Promise.all([
    getCurrentUser().catch(() => null),
    cookies(),
    headers(),
    getAllSettings(db),
  ]);
  const locale = resolveLocale({
    user: user?.locale,
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    site: settings['site.defaultLocale'],
    acceptLanguage: h.get('accept-language'),
  });
  return {
    locale,
    messages: { ...messages[locale], mod: moduleMessages[locale] },
    timeZone: user?.timezone ?? settings['site.defaultTimezone'],
  };
});
