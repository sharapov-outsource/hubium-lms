import { Button } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export default async function Forbidden() {
  const t = await getTranslations('common');
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-semibold text-muted-foreground">403</p>
      <h1 className="text-xl font-semibold">{t('forbidden')}</h1>
      <Button asChild variant="secondary">
        <Link href="/">{t('toHome')}</Link>
      </Button>
    </main>
  );
}
