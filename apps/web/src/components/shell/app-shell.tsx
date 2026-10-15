import {
  enabledLanguages,
  getAllSettings,
  unreadConversationCount,
  unreadNotificationCount,
} from '@hubium/core';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { LiveCountsProvider } from '@/components/comms/live-counts';
import { NotificationBell } from '@/components/comms/notification-bell';
import { LocaleSwitcher, ThemeSwitcher } from '@/components/locale-theme-switcher';
import { RealtimeProvider } from '@/components/realtime';
import { SiteLogo } from '@/components/site-logo';
import { buildInfo } from '@/lib/build-info';
import { db } from '@/server/db';
import type { CurrentUser } from '@/server/session';
import { MobileMenu } from './mobile-menu';
import { type NavItem, navIcon } from './nav-items';
import { NavLink } from './nav-link';
import { UserMenu } from './user-menu';

export async function AppShell({
  user,
  items,
  children,
  topbarExtra,
}: {
  user: CurrentUser;
  items: NavItem[];
  children: ReactNode;
  topbarExtra?: ReactNode;
}) {
  const [settings, t, format, notifications, messages, languages] = await Promise.all([
    getAllSettings(db),
    getTranslations(),
    getFormatter(),
    unreadNotificationCount(db, user.id),
    unreadConversationCount(db, user.id),
    enabledLanguages(db),
  ]);
  const primary = items.filter((i) => i.mobile);
  const builtAt = buildInfo.builtAt
    ? format.dateTime(new Date(buildInfo.builtAt), { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  return (
    <RealtimeProvider>
      <LiveCountsProvider initial={{ notifications, messages }}>
        <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
          <a
            href="#main"
            className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-accent-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
          >
            {t('common.skipToContent')}
          </a>
          <aside className="sticky top-0 hidden h-dvh flex-col gap-4 border-r border-border bg-surface px-3 py-4 lg:flex">
            <div className="px-2">
              <SiteLogo
                name={settings['site.name']}
                hasLogo={!!settings['branding.logoFileId']}
                href="/dashboard"
              />
            </div>
            <nav
              aria-label={t('nav.main')}
              className="flex flex-1 flex-col gap-0.5 overflow-y-auto"
            >
              {items.map((it) => (
                <NavLink
                  key={it.href}
                  href={it.href}
                  icon={navIcon(it.icon)}
                  label={t(it.label)}
                  exact={it.exact}
                  badge={it.badge}
                  liveBadge={it.liveBadge}
                />
              ))}
            </nav>
            <p
              className="px-2 text-xs tabular-nums text-muted-foreground"
              title={builtAt ? t('common.buildDate', { date: builtAt }) : undefined}
            >
              Hubium LMS {buildInfo.version}
              {buildInfo.commit ? ` · ${buildInfo.commit}` : null}
            </p>
          </aside>
          <div className="flex min-w-0 flex-col">
            <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
              <MobileMenu
                label={t('nav.openMenu')}
                title={t('nav.main')}
                closeLabel={t('common.close')}
              >
                {items.map((it) => (
                  <NavLink
                    key={it.href}
                    href={it.href}
                    icon={navIcon(it.icon)}
                    label={t(it.label)}
                    exact={it.exact}
                    badge={it.badge}
                    liveBadge={it.liveBadge}
                  />
                ))}
              </MobileMenu>
              <div className="lg:hidden">
                <SiteLogo
                  name={settings['site.name']}
                  hasLogo={!!settings['branding.logoFileId']}
                  href="/dashboard"
                />
              </div>
              <div className="flex-1" />
              {topbarExtra}
              <NotificationBell />
              <LocaleSwitcher languages={languages} />
              <ThemeSwitcher />
              <UserMenu
                user={{ id: user.id, name: user.name, email: user.email, image: user.image }}
              />
            </header>
            <main
              id="main"
              tabIndex={-1}
              className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-6 outline-none sm:px-6 lg:pb-10"
            >
              {children}
            </main>
            <nav
              aria-label={t('nav.main')}
              className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
            >
              {primary.map((it) => (
                <NavLink
                  key={it.href}
                  href={it.href}
                  icon={navIcon(it.icon)}
                  label={t(it.mobileLabel ?? it.label)}
                  exact={it.exact}
                  variant="bottom"
                  badge={it.badge}
                  liveBadge={it.liveBadge}
                />
              ))}
            </nav>
          </div>
        </div>
      </LiveCountsProvider>
    </RealtimeProvider>
  );
}
