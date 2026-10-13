import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { OfflineRetry } from './retry';

export const generateMetadata = titled('offline', 'title');

// Precached by the service worker and shown when a navigation fails offline.
export default async function OfflinePage() {
  const t = await getTranslations('offline');
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-6">
      <div className="grid max-w-sm gap-3 text-center">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('text')}</p>
        <OfflineRetry label={t('retry')} />
      </div>
    </main>
  );
}
