import { getAllSettings } from '@hubium/core';
import type { ReactNode } from 'react';
import { LocaleThemeSwitcher } from '@/components/locale-theme-switcher';
import { SiteLogo } from '@/components/site-logo';
import { db } from '@/server/db';

/** Full-page steps a signed-in user must complete before using the site (policies). */
export default async function GateLayout({ children }: { children: ReactNode }) {
  const settings = await getAllSettings(db);
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <SiteLogo name={settings['site.name']} hasLogo={!!settings['branding.logoFileId']} />
        <LocaleThemeSwitcher />
      </header>
      <main id="main" className="flex flex-1 justify-center px-4 pb-16 pt-6">
        <div className="w-full max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
