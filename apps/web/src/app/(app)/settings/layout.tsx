import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SettingsTabs } from './tabs';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('settings');
  return (
    <div className="max-w-3xl">
      <PageHeader title={t('title')} />
      <SettingsTabs
        label={t('title')}
        items={[
          { key: 'account', href: '/settings/account', label: t('account') },
          { key: 'security', href: '/settings/security', label: t('security') },
          { key: 'preferences', href: '/settings/preferences', label: t('preferences') },
          { key: 'notifications', href: '/settings/notifications', label: t('notifications') },
          { key: 'messages', href: '/settings/messages', label: t('messages') },
          { key: 'api-tokens', href: '/settings/api-tokens', label: t('apiTokens') },
          { key: 'privacy', href: '/settings/privacy', label: t('privacy') },
        ]}
      />
      {children}
    </div>
  );
}
