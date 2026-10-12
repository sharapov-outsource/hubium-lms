import { flattenTree, getCategoryTree, searchCatalog } from '@hubium/core';
import { excerpt } from '@hubium/editor/server';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { courseGradient, courseImageUrl } from '@/components/course-card';
import { Pagination } from '@/components/pagination';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

export async function generateMetadata() {
  return { title: (await getTranslations('catalog'))('title') };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; page?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const [t, tc] = await Promise.all([getTranslations('catalog'), getTranslations('common')]);
  const ctx = await getContext();
  const categoryId = sp.category && /^[0-9a-f-]{36}$/.test(sp.category) ? sp.category : undefined;
  const [tree, res] = await Promise.all([
    getCategoryTree(db),
    searchCatalog(ctx, { q: sp.q, categoryId, page: Number(sp.page) || 1 }),
  ]);
  const flat = flattenTree(tree);
  return (
    <>
      <PageHeader title={t('title')} description={t('coursesCount', { count: res.total })} />
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <nav aria-label={t('categories')} className="grid content-start gap-0.5">
          <Link
            href="/catalog"
            aria-current={!categoryId ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm',
              !categoryId ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-muted',
            )}
          >
            {t('allCategories')}
          </Link>
          {flat.map((c) => (
            <Link
              key={c.id}
              href={`/catalog?category=${c.id}`}
              aria-current={categoryId === c.id ? 'page' : undefined}
              className={cn(
                'flex justify-between rounded-md px-3 py-1.5 text-sm',
                categoryId === c.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-muted',
              )}
              style={{ paddingLeft: `${0.75 + c.depth * 0.9}rem` }}
            >
              <span className="truncate">{c.name}</span>
            </Link>
          ))}
        </nav>
        <div>
          <search className="mb-5 block">
            <form className="flex max-w-lg gap-2">
              {categoryId ? <input type="hidden" name="category" value={categoryId} /> : null}
              <label htmlFor="q" className="sr-only">
                {t('search')}
              </label>
              <Input id="q" name="q" defaultValue={sp.q} placeholder={t('search')} />
              <Button type="submit" variant="secondary" aria-label={tc('search')}>
                <Search />
              </Button>
            </form>
          </search>
          {res.items.length === 0 ? (
            <EmptyState title={t('empty')} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {res.items.map((c) => {
                const img = courseImageUrl(c.imageFileId);
                const self = c.enrolmentMethods.some((m) => m.type === 'SELF');
                return (
                  <Card key={c.id} className="group overflow-hidden">
                    <Link href={`/course/${c.id}`} className="block">
                      <div
                        className="h-24"
                        style={
                          img
                            ? {
                                backgroundImage: `url(${img})`,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                              }
                            : { background: courseGradient(c.id) }
                        }
                      />
                      <div className="grid gap-2 p-4">
                        <p className="text-xs text-muted-foreground">{c.category.name}</p>
                        <h2 className="font-semibold leading-snug group-hover:underline">
                          {c.fullName}
                        </h2>
                        {c.summary ? (
                          <p className="line-clamp-3 text-sm text-muted-foreground">
                            {excerpt(c.summary, 180)}
                          </p>
                        ) : null}
                        <div className="flex flex-wrap gap-1">
                          {self ? <Badge variant="accent">{t('enrol')}</Badge> : null}
                          {c.guestAccess ? <Badge>{t('guest')}</Badge> : null}
                        </div>
                      </div>
                    </Link>
                  </Card>
                );
              })}
            </div>
          )}
          <Pagination
            page={res.page}
            pageSize={res.pageSize}
            total={res.total}
            params={{ q: sp.q, category: categoryId }}
          />
        </div>
      </div>
    </>
  );
}
