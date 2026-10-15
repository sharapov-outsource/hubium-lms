import { getAllSettings } from '@hubium/core';
import { languageInfo } from '@hubium/i18n/packs';
import { generateAccentPalette, paletteCss } from '@hubium/ui/palette';
import { ThemeProvider, Toaster } from '@hubium/ui/theme';
import { UiTextProvider } from '@hubium/ui/ui-text';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ServiceWorker } from '@/components/service-worker';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';
import './globals.css';

// Every page depends on the request (CSP nonce, session, site settings), so nothing is
// prerendered and `next build` never touches the database.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAllSettings(db);
  return {
    title: { default: settings['site.name'], template: `%s — ${settings['site.name']}` },
    description: 'Hubium LMS',
    icons: { apple: '/icons/apple-touch-icon.png' },
    appleWebApp: { capable: true, title: settings['site.name'], statusBarStyle: 'default' },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111318' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, settings, user, h, tf] = await Promise.all([
    getLocale(),
    getAllSettings(db),
    getCurrentUser(),
    headers(),
    getTranslations('common'),
  ]);
  const uiText = {
    chooseFile: tf('file.chooseFile'),
    chooseFiles: tf('file.chooseFiles'),
    noFile: tf('file.noFile'),
    noFiles: tf('file.noFiles'),
    search: tf('searchPlaceholder'),
    nothingFound: tf('nothingFound'),
    close: tf('close'),
  };
  const nonce = h.get('x-nonce') ?? undefined;
  const palette = generateAccentPalette(settings['branding.accent']);
  return (
    <html lang={locale} dir={languageInfo(locale).dir} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: generated from a validated hex colour */}
        <style id="hubium-brand" dangerouslySetInnerHTML={{ __html: paletteCss(palette) }} />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider defaultTheme={user?.theme ?? 'system'} nonce={nonce}>
          <NextIntlClientProvider>
            <UiTextProvider value={uiText}>{children}</UiTextProvider>
            <Toaster />
            <ServiceWorker />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
