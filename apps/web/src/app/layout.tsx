import { getAllSettings } from '@hubium/core';
import { generateAccentPalette, paletteCss } from '@hubium/ui/palette';
import { ThemeProvider, Toaster } from '@hubium/ui/theme';
import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import type { ReactNode } from 'react';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getAllSettings(db);
  return {
    title: { default: settings['site.name'], template: `%s — ${settings['site.name']}` },
    description: 'Hubium LMS',
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
  const [locale, settings, user] = await Promise.all([
    getLocale(),
    getAllSettings(db),
    getCurrentUser(),
  ]);
  const palette = generateAccentPalette(settings['branding.accent']);
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: generated from a validated hex colour */}
        <style id="hubium-brand" dangerouslySetInnerHTML={{ __html: paletteCss(palette) }} />
      </head>
      <body className="min-h-dvh">
        <ThemeProvider defaultTheme={user?.theme ?? 'system'}>
          <NextIntlClientProvider>
            {children}
            <Toaster />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
