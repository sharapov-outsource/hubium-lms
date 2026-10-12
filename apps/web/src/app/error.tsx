'use client';

import { Button } from '@hubium/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

/** Unexpected errors in a page: say so plainly and offer a retry instead of a blank screen. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common');
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="text-xl font-semibold">{t('error')}</h1>
      <p className="text-sm text-muted-foreground">{t('errorText')}</p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          {t('errorCode')}: <code>{error.digest}</code>
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={reset}>{t('retry')}</Button>
        <Button asChild variant="secondary">
          <Link href="/">{t('toHome')}</Link>
        </Button>
      </div>
    </main>
  );
}
