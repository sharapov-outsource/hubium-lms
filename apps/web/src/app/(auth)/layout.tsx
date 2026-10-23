import { enabledLanguages, getAllSettings } from '@hubium/core';
import type { ReactNode } from 'react';
import { LocaleThemeSwitcher } from '@/components/locale-theme-switcher';
import { NodeBanner } from '@/components/shell/node-banner';
import { SiteLogo } from '@/components/site-logo';
import { db } from '@/server/db';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [settings, languages] = await Promise.all([getAllSettings(db), enabledLanguages(db)]);
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <SiteLogo name={settings['site.name']} hasLogo={!!settings['branding.logoFileId']} />
        <LocaleThemeSwitcher languages={languages} />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-16">
        <div className="w-full max-w-sm">
          <NodeBanner />
          {children}
        </div>
      </main>
    </div>
  );
}
