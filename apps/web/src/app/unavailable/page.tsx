import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('nodes', 'unavailable.title');

/**
 * A local node's answer to a change it cannot make now (docs/architecture.md §1.7): no
 * connection to the main server for a while yet, or the sync of what it did without one.
 */
export default async function UnavailablePage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const t = await getTranslations('nodes.unavailable');
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-6">
      <div className="grid max-w-md gap-3 text-center">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t(reason === 'sync' ? 'sync' : 'offline')}</p>
        <Link href="/dashboard" className="text-sm font-medium text-accent hover:underline">
          {t('back')}
        </Link>
      </div>
    </main>
  );
}
