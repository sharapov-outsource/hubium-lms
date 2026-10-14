import {
  courseFieldLabel,
  flattenTree,
  getCategoryTree,
  listCourseFields,
  searchCatalog,
} from '@hubium/core';
import { excerpt } from '@hubium/editor/server';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { courseGradient, courseImageUrl } from '@/components/course-card';
import { Pagination } from '@/components/pagination';
import { courseFieldDisplay } from '@/server/course-fields';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

export async function generateMetadata() {
  return { title: (await getTranslations('catalog'))('title') };
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const [t, tc, locale] = await Promise.all([
    getTranslations('catalog'),
    getTranslations('common'),
    getLocale(),
  ]);
  const ctx = await getContext();
  const categoryId = sp.category && /^[0-9a-f-]{36}$/.test(sp.category) ? sp.category : undefined;
  // visible menu and checkbox course fields filter the catalog (f_<short name>)
  const courseFields = await listCourseFields(db);
  const filterable = courseFields.filter(
    (f) => f.visible && (f.type === 'menu' || f.type === 'checkbox'),
  );
  const fields = Object.fromEntries(
    filterable.flatMap((f) =>
      sp[`f_${f.shortName}`] ? [[f.shortName, sp[`f_${f.shortName}`]!]] : [],
    ),
  );
  const [tree, res] = await Promise.all([
    getCategoryTree(db),
    searchCatalog(ctx, { q: sp.q, categoryId, page: Number(sp.page) || 1, fields }),
  ]);
  const flat = flattenTree(tree);
  const shown = await Promise.all(
    res.items.map((c) => courseFieldDisplay(c.customFields, locale, courseFields)),
  );
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
            <form className="grid gap-3">
              <div className="flex max-w-lg gap-2">
                {categoryId ? <input type="hidden" name="category" value={categoryId} /> : null}
                <label htmlFor="q" className="sr-only">
                  {t('search')}
                </label>
                <Input id="q" name="q" defaultValue={sp.q} placeholder={t('search')} />
                <Button type="submit" variant="secondary" aria-label={tc('search')}>
                  <Search />
                </Button>
              </div>
              {filterable.length ? (
                <div className="flex flex-wrap items-end gap-3">
                  {filterable.map((f) => (
                    <label key={f.id} htmlFor={`f_${f.shortName}`} className="grid gap-1 text-sm">
                      {courseFieldLabel(f, locale)}
                      <Select
                        id={`f_${f.shortName}`}
                        name={`f_${f.shortName}`}
                        defaultValue={fields[f.shortName] ?? ''}
                        className="w-48"
                      >
                        <option value="">{t('anyValue')}</option>
                        {f.type === 'menu' ? (
                          f.choices.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="yes">{tc('yes')}</option>
                            <option value="no">{tc('no')}</option>
                          </>
                        )}
                      </Select>
                    </label>
                  ))}
                  <Button type="submit" variant="outline">
                    {t('applyFilters')}
                  </Button>
                </div>
              ) : null}
            </form>
          </search>
          {res.items.length === 0 ? (
            <EmptyState title={t('empty')} />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {res.items.map((c, i) => {
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
                        {shown[i]!.length ? (
                          <dl className="grid gap-0.5 text-xs">
                            {shown[i]!.map((v) => (
                              <div key={v.key} className="flex gap-1">
                                <dt className="text-muted-foreground">{v.label}:</dt>
                                <dd>{v.text}</dd>
                              </div>
                            ))}
                          </dl>
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
            params={{
              q: sp.q,
              category: categoryId,
              ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`f_${k}`, v])),
            }}
          />
        </div>
      </div>
    </>
  );
}
