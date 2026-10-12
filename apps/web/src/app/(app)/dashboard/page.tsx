import { Alert, Button, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireUser } from '@/server/session';

export async function generateMetadata() {
  const t = await getTranslations('nav');
  return { title: t('dashboard') };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations('dashboard');
  return (
    <>
      <PageHeader
        title={t('title', { name: user.firstName || user.name })}
        description={t('subtitle')}
      />
      {user.isSiteAdmin ? (
        <Alert className="flex flex-wrap items-center justify-between gap-3">
          <span>{t('adminHint')}</span>
          <Button asChild size="sm">
            <Link href="/admin">{t('toAdmin')}</Link>
          </Button>
        </Alert>
      ) : null}
    </>
  );
}
