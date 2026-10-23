'use server';

import { enabledLocales, getAllSettings, setMyPreferences } from '@hubium/core';
import { LOCALE_COOKIE } from '@hubium/i18n';
import { cookies } from 'next/headers';
import { db } from '../db';
import { getContext } from '../session';

export async function setLocaleAction(locale: string): Promise<void> {
  if (!enabledLocales(await getAllSettings(db)).includes(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const ctx = await getContext();
  if (ctx.actor.kind === 'user') await setMyPreferences.run(ctx, { locale });
}

export async function setThemeAction(theme: string): Promise<void> {
  if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return;
  const ctx = await getContext();
  if (ctx.actor.kind === 'user') await setMyPreferences.run(ctx, { theme });
}
