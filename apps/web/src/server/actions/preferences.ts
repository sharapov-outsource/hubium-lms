'use server';

import { enabledLocales, getAllSettings } from '@hubium/core';
import { LOCALE_COOKIE } from '@hubium/i18n';
import { cookies } from 'next/headers';
import { db } from '../db';
import { getCurrentUser } from '../session';

export async function setLocaleAction(locale: string): Promise<void> {
  if (!enabledLocales(await getAllSettings(db)).includes(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const user = await getCurrentUser();
  if (user) await db.user.update({ where: { id: user.id }, data: { locale } });
}

export async function setThemeAction(theme: string): Promise<void> {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  const user = await getCurrentUser();
  if (user) await db.user.update({ where: { id: user.id }, data: { theme } });
}
