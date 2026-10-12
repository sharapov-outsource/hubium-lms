import { Button } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

export async function Pagination({
  page,
  pageSize,
  total,
  params = {},
}: {
  page: number;
  pageSize: number;
  total: number;
  params?: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const t = await getTranslations('common');
  const href = (p: number) => {
    const sp = new URLSearchParams(
      Object.entries(params).filter((e): e is [string, string] => !!e[1]),
    );
    sp.set('page', String(p));
    return `?${sp}`;
  };
  return (
    <nav
      className="mt-4 flex items-center justify-between gap-2 text-sm"
      aria-label={t('pageOf', { page, pages })}
    >
      <span className="text-muted-foreground">{t('pageOf', { page, pages })}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page - 1)}>{t('previous')}</Link>
          </Button>
        ) : null}
        {page < pages ? (
          <Button asChild variant="outline" size="sm">
            <Link href={href(page + 1)}>{t('next')}</Link>
          </Button>
        ) : null}
      </div>
    </nav>
  );
}
