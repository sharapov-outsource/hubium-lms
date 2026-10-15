import { RichText } from '@hubium/editor/client';
import { scaleItems } from '@hubium/module-sdk/ratings';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Button, EmptyState, Input } from '@hubium/ui';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { type GlossarySettingsT, glossaryEntries } from '../server.ts';
import { EntryForm, EntryRating, EntryTools } from './client.tsx';

type Props = ViewProps<GlossarySettingsT>;
type Filters = { q?: string; letter?: string; category?: string; pending?: string; page?: number };

export async function GlossaryView({ activity: a, course, ctx, searchParams: sp }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.glossary'), getFormatter()]);
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;
  const [canWrite, manage] = await Promise.all([
    ctx.perm.can('mod.glossary:write', a.id),
    ctx.perm.can('mod.glossary:manageentries', a.id),
  ]);

  if (canWrite && (sp.add === '1' || sp.edit)) {
    const [editing, all] = await Promise.all([
      sp.edit ? glossaryEntries(ctx, a, { entryId: sp.edit }) : null,
      glossaryEntries(ctx, a, { page: 1 }),
    ]);
    const entry = editing?.items[0];
    if (sp.edit && !entry?.canEdit) return <Alert variant="destructive">{t('cannotEdit')}</Alert>;
    return (
      <div className="grid max-w-3xl gap-4" data-no-autolink>
        <h2 className="text-lg font-semibold">{entry ? t('editEntry') : t('addEntry')}</h2>
        <EntryForm
          activityId={a.id}
          courseId={course.id}
          base={base}
          entry={entry}
          linking={s.autoLink}
          categories={all.categories}
        />
      </div>
    );
  }

  const filters: Filters = {
    q: sp.q?.trim() || undefined,
    letter: sp.letter || undefined,
    category: sp.category || undefined,
    pending: manage && sp.pending === '1' ? '1' : undefined,
    page: Math.max(1, Number(sp.page) || 1),
  };
  const href = (f: Filters) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f))
      if (v !== undefined && !(k === 'page' && v === 1)) q.set(k, String(v));
    const qs = q.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const one = sp.entry;
  const [r, scale] = await Promise.all([
    glossaryEntries(ctx, a, {
      search: filters.q,
      letter: filters.letter,
      category: filters.category,
      pending: !!filters.pending,
      entryId: one,
      page: filters.page,
    }),
    s.ratingAggregate === 'none' ? null : scaleItems(ctx.db, course.id, s.ratingScaleId),
  ]);
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
  const filtered = !!(filters.q || filters.letter || filters.category || filters.pending);

  const entries = (
    <ul className="grid gap-3">
      {r.items.map((e) => (
        <li key={e.id}>
          <article
            aria-labelledby={`gl-${e.id}`}
            className="grid gap-2 rounded-lg border border-border p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id={`gl-${e.id}`} className="text-base font-semibold">
                {one ? (
                  e.concept
                ) : (
                  <Link href={`${base}?entry=${e.id}`} className="hover:underline">
                    {e.concept}
                  </Link>
                )}
              </h3>
              {e.approved ? null : <Badge variant="warning">{t('awaiting')}</Badge>}
            </div>
            {e.aliases.length ? (
              <p className="text-xs text-muted-foreground">
                {t('alsoCalled', { words: e.aliases.join(', ') })}
              </p>
            ) : null}
            <RichText html={e.definition} />
            {e.categories.length ? (
              <ul className="flex flex-wrap gap-1" aria-label={t('categories')}>
                {e.categories.map((c) => (
                  <li key={c}>
                    <Link href={href({ category: c })}>
                      <Badge variant="neutral">{c}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {s.displayFormat === 'full' ? (
              <p className="text-xs text-muted-foreground">
                {t('byline', {
                  name: e.author?.name ?? t('formerUser'),
                  time: format.dateTime(e.createdAt, { dateStyle: 'medium' }),
                })}
                {e.updatedAt.getTime() - e.createdAt.getTime() > 60_000
                  ? ` · ${t('updated', { time: format.dateTime(e.updatedAt, { dateStyle: 'medium' }) })}`
                  : null}
              </p>
            ) : null}
            {e.rating && s.ratingAggregate !== 'none' ? (
              <EntryRating
                activityId={a.id}
                entryId={e.id}
                authorName={e.author?.name ?? t('formerUser')}
                kind={s.ratingAggregate}
                scale={scale}
                max={s.ratingMax}
                rating={e.rating}
              />
            ) : null}
            <EntryTools
              activityId={a.id}
              base={base}
              entry={e}
              canEdit={e.canEdit}
              canApprove={e.canApprove}
            />
          </article>
        </li>
      ))}
    </ul>
  );

  if (one)
    return (
      <div className="grid max-w-3xl gap-4" data-no-autolink>
        <Link
          href={base}
          className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t('allEntries')}
        </Link>
        {r.items.length ? entries : <Alert>{t('notFound')}</Alert>}
      </div>
    );

  return (
    <div className="grid max-w-3xl gap-5" data-no-autolink>
      <div className="flex flex-wrap items-center gap-2">
        <search className="flex min-w-0 flex-1">
          <form method="get" action={base} className="flex min-w-0 flex-1 gap-2">
            <Input
              name="q"
              type="search"
              defaultValue={filters.q}
              aria-label={t('searchLabel')}
              placeholder={t('search')}
              className="min-w-0 flex-1"
              maxLength={200}
            />
            <Button type="submit" variant="outline" size="icon" aria-label={t('search')}>
              <Search className="size-4" />
            </Button>
          </form>
        </search>
        {canWrite ? (
          <Button asChild>
            <Link href={`${base}?add=1`}>
              <Plus aria-hidden />
              {t('addEntry')}
            </Link>
          </Button>
        ) : null}
      </div>
      {manage && (r.pendingCount || filters.pending) ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('views')}>
          <Button asChild size="sm" variant={filters.pending ? 'ghost' : 'secondary'}>
            <Link href={base} aria-current={filters.pending ? undefined : 'page'}>
              {t('allEntries')}
            </Link>
          </Button>
          <Button asChild size="sm" variant={filters.pending ? 'secondary' : 'ghost'}>
            <Link href={href({ pending: '1' })} aria-current={filters.pending ? 'page' : undefined}>
              {t('pendingTab', { n: r.pendingCount })}
            </Link>
          </Button>
        </nav>
      ) : null}
      {r.letters.length ? (
        <nav aria-label={t('letters')} className="flex flex-wrap gap-1 text-sm">
          {[undefined, ...r.letters].map((l) => (
            <Link
              key={l ?? 'all'}
              href={href({ category: filters.category, pending: filters.pending, letter: l })}
              aria-current={filters.letter === l ? 'page' : undefined}
              className="rounded-md px-2 py-1 hover:bg-muted aria-[current=page]:bg-secondary aria-[current=page]:font-semibold"
            >
              {l ?? t('all')}
            </Link>
          ))}
        </nav>
      ) : null}
      {r.categories.length ? (
        <nav aria-label={t('categories')} className="flex flex-wrap gap-1 text-sm">
          {[undefined, ...r.categories].map((c) => (
            <Link
              key={c ?? 'all'}
              href={href({ letter: filters.letter, pending: filters.pending, category: c })}
              aria-current={filters.category === c ? 'page' : undefined}
              className="rounded-full border border-border px-2.5 py-0.5 hover:bg-muted aria-[current=page]:bg-secondary aria-[current=page]:font-semibold"
            >
              {c ?? t('allCategories')}
            </Link>
          ))}
        </nav>
      ) : null}
      {filtered ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('found', { n: r.total })}{' '}
          <Link href={base} className="text-accent underline">
            {t('resetFilters')}
          </Link>
        </p>
      ) : null}
      {r.items.length ? (
        entries
      ) : filtered ? null : (
        <EmptyState
          title={canWrite ? t('emptyWriter') : t('empty')}
          action={
            canWrite ? (
              <Button asChild>
                <Link href={`${base}?add=1`}>{t('addEntry')}</Link>
              </Button>
            ) : undefined
          }
        />
      )}
      {pages > 1 ? (
        <nav
          aria-label={t('pagination')}
          className="flex items-center justify-between gap-2 text-sm"
        >
          {r.page > 1 ? (
            <Link
              href={href({ ...filters, page: r.page - 1 })}
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <ChevronLeft className="size-4" aria-hidden />
              {t('prev')}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">{t('pageOf', { page: r.page, pages })}</span>
          {r.page < pages ? (
            <Link
              href={href({ ...filters, page: r.page + 1 })}
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t('next')}
              <ChevronRight className="size-4" aria-hidden />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}
