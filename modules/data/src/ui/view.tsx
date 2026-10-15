import { RichText } from '@hubium/editor/client';
import { scaleItems } from '@hubium/module-sdk/ratings';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Button, EmptyState, Input, Select } from '@hubium/ui';
import { ChevronLeft, ChevronRight, Download, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { defaultTemplate, renderTemplate } from '../fields.ts';
import { type DataSettingsT, dataFields, dataRecords } from '../server.ts';
import {
  EntryForm,
  EntryRating,
  EntryTools,
  FieldForm,
  FieldTools,
  ImportEntries,
} from './client.tsx';

type Props = ViewProps<DataSettingsT>;
const TABS = ['entries', 'fields', 'import'] as const;

export async function DatabaseView(props: Props) {
  const { activity: a, course, ctx, searchParams: sp } = props;
  const t = await getTranslations('mod.data');
  const [canFields, canManage, canWrite, canExport] = await Promise.all([
    ctx.perm.can('mod.data:managefields', a.id),
    ctx.perm.can('mod.data:manageentries', a.id),
    ctx.perm.can('mod.data:writeentry', a.id),
    ctx.perm.can('mod.data:exportentries', a.id),
  ]);
  const base = `/course/${course.id}/a/${a.id}`;
  const allowed = { entries: true, fields: canFields, import: canManage };
  const tabs = TABS.filter((k) => allowed[k]);
  const tab = tabs.find((k) => k === sp.tab) ?? 'entries';
  return (
    <div className="grid gap-5" data-no-autolink>
      {tabs.length > 1 ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('tabsLabel')}>
          {tabs.map((k) => (
            <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
              <Link
                href={k === 'entries' ? base : `${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
              >
                {t(`tabs.${k}`)}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
      {tab === 'fields' ? (
        <FieldsTab {...props} />
      ) : tab === 'import' ? (
        <div className="grid max-w-3xl gap-4">
          <ImportEntries activityId={a.id} />
        </div>
      ) : (
        <EntriesTab {...props} canWrite={canWrite} canExport={canExport} />
      )}
    </div>
  );
}

async function EntriesTab({
  activity: a,
  course,
  ctx,
  searchParams: sp,
  canWrite,
  canExport,
}: Props & { canWrite: boolean; canExport: boolean }) {
  const [t, format] = await Promise.all([getTranslations('mod.data'), getFormatter()]);
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;

  if (canWrite && (sp.add === '1' || sp.edit)) {
    const fields = await dataFields(ctx.db, a.id);
    const editing = sp.edit ? await dataRecords(ctx, a, { recordId: sp.edit }) : null;
    const entry = editing?.items[0];
    if (sp.edit && !entry?.canEdit) return <Alert variant="destructive">{t('cannotEdit')}</Alert>;
    if (!fields.length) return <EmptyState title={t('noFields')} />;
    return (
      <div className="grid max-w-3xl gap-4">
        <h2 className="text-lg font-semibold">{entry ? t('editEntry') : t('addEntry')}</h2>
        <EntryForm
          activityId={a.id}
          courseId={course.id}
          base={base}
          fields={fields}
          entry={entry ? { id: entry.id, values: entry.values } : undefined}
          files={editing?.files ?? {}}
        />
      </div>
    );
  }

  const one = sp.record;
  const pending = sp.pending === '1';
  const [r, scale] = await Promise.all([
    dataRecords(ctx, a, {
      search: sp.q,
      sort: sp.sort,
      order: sp.order === 'asc' || sp.order === 'desc' ? sp.order : undefined,
      page: Math.max(1, Number(sp.page) || 1),
      pending,
      recordId: one,
    }),
    s.ratingAggregate === 'none' ? null : scaleItems(ctx.db, course.id, s.ratingScaleId),
  ]);
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });
  // a date without a time: the same date in every time zone
  const day = (v: string) =>
    format.dateTime(new Date(`${v}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' });
  const template = one
    ? s.singleTemplate || defaultTemplate(r.fields, 'single')
    : s.listTemplate || defaultTemplate(r.fields, 'list');
  const href = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const keep = { q: sp.q, sort: sp.sort, order: sp.order, pending: pending ? '1' : undefined };
  const pages = Math.max(1, Math.ceil(r.total / r.pageSize));

  const entries = (
    <ul className="grid gap-3">
      {r.items.map((e) => (
        <li key={e.id}>
          <article
            aria-label={t('entryBy', { name: e.user?.name ?? t('formerUser') })}
            className="grid gap-2 rounded-lg border border-border p-4"
          >
            {e.approved ? null : (
              <Badge variant="warning" className="justify-self-start">
                {t('awaiting')}
              </Badge>
            )}
            <RichText
              html={renderTemplate(template, r.fields, e.values, {
                user: e.user?.name ?? t('formerUser'),
                added: when(e.createdAt),
                modified: when(e.updatedAt),
                moreUrl: `${base}?record=${e.id}`,
                moreLabel: t('more'),
                date: day,
                file: (id) => r.files[id],
              })}
            />
            {e.rating && s.ratingAggregate !== 'none' ? (
              <EntryRating
                activityId={a.id}
                recordId={e.id}
                authorName={e.user?.name ?? t('formerUser')}
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
      <div className="grid max-w-3xl gap-4">
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
    <div className="grid max-w-4xl gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <search className="min-w-0 flex-1">
          <form method="get" action={base} className="flex flex-wrap items-end gap-2">
            <Input
              name="q"
              type="search"
              defaultValue={sp.q}
              aria-label={t('searchLabel')}
              placeholder={t('search')}
              className="w-56 min-w-0 flex-1"
              maxLength={200}
            />
            <Select name="sort" aria-label={t('sortBy')} defaultValue={r.sort} className="w-48">
              <option value="">{t('timeAdded')}</option>
              {r.fields
                .filter((f) => f.type !== 'file' && f.type !== 'image')
                .map((f) => (
                  <option key={f.id} value={f.name}>
                    {f.name}
                  </option>
                ))}
            </Select>
            <Select name="order" aria-label={t('order')} defaultValue={r.order} className="w-40">
              <option value="asc">{t('ascending')}</option>
              <option value="desc">{t('descending')}</option>
            </Select>
            <Button type="submit" variant="outline">
              <Search aria-hidden />
              {t('search')}
            </Button>
          </form>
        </search>
        {canWrite && r.fields.length ? (
          <Button asChild>
            <Link href={`${base}?add=1`}>
              <Plus aria-hidden />
              {t('addEntry')}
            </Link>
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground" aria-live="polite">
          {t('found', { n: r.total })}
          {sp.q || pending ? (
            <>
              {' '}
              <Link href={base} className="text-accent underline">
                {t('showAll')}
              </Link>
            </>
          ) : null}
        </span>
        <span className="flex flex-wrap gap-3">
          {r.pendingCount ? (
            <Link href={href({ ...keep, pending: '1' })} className="text-accent hover:underline">
              {t('pendingCount', { n: r.pendingCount })}
            </Link>
          ) : null}
          {canExport
            ? (['csv', 'xlsx'] as const).map((f) => (
                <a
                  key={f}
                  href={`/api/mod/data/${a.id}/entries.${f}`}
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  <Download className="size-4" aria-hidden />
                  {f.toUpperCase()}
                </a>
              ))
            : null}
        </span>
      </div>
      {r.missing ? <Alert>{t('addFirst', { n: r.missing })}</Alert> : null}
      {r.items.length ? (
        entries
      ) : sp.q || pending ? null : (
        <EmptyState title={r.fields.length ? t('empty') : t('noFields')} />
      )}
      {pages > 1 ? (
        <nav
          aria-label={t('pagination')}
          className="flex items-center justify-between gap-2 text-sm"
        >
          {r.page > 1 ? (
            <Link
              href={href({ ...keep, page: String(r.page - 1) })}
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
              href={href({ ...keep, page: String(r.page + 1) })}
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

async function FieldsTab({ activity: a, course, ctx, searchParams: sp }: Props) {
  const t = await getTranslations('mod.data');
  const base = `/course/${course.id}/a/${a.id}`;
  const fields = await dataFields(ctx.db, a.id);
  const editing = sp.field ? fields.find((f) => f.id === sp.field) : undefined;
  return (
    <div className="grid max-w-3xl gap-4">
      {fields.length ? (
        <ol className="grid gap-2">
          {fields.map((f, i) => (
            <li
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="grid">
                <span className="font-medium">
                  {f.name}
                  {f.required ? ' *' : ''}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t(`types.${f.type}`)}
                  {f.options.choices?.length ? `: ${f.options.choices.join(', ')}` : ''}
                </span>
              </span>
              <FieldTools
                activityId={a.id}
                base={base}
                field={f}
                first={i === 0}
                last={i === fields.length - 1}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t('fields.empty')}</p>
      )}
      <FieldForm key={editing?.id ?? 'new'} activityId={a.id} base={base} field={editing} />
      <p className="text-sm text-muted-foreground">{t('fields.templatesHint')}</p>
    </div>
  );
}
