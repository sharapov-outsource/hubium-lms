import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Button, Card, CardContent } from '@hubium/ui';
import { History, ListTree, Pencil } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  firstTitle,
  resolveSubwiki,
  type WikiSettingsT,
  wikiCompare,
  wikiHistory,
  wikiIndex,
  wikiPage,
} from '../server.ts';
import { normTitle, renderLinks } from '../text.ts';
import { DeletePage, RestoreVersion, WikiEditor } from './client.tsx';

type Props = ViewProps<WikiSettingsT>;

export async function WikiView({ activity: a, course, ctx, searchParams: sp }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.wiki'), getFormatter()]);
  const base = `/course/${course.id}/a/${a.id}`;
  const r = await resolveSubwiki(ctx, a, { groupId: sp.group, userId: sp.user });
  const canOverride = await ctx.perm.can('mod.wiki:overridelock', a.id);
  // links keep the wiki chosen
  const href = (q: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (r.ref.groupId && r.groups.length > 1) p.set('group', r.ref.groupId);
    if (r.ref.userId && r.users.length) p.set('user', r.ref.userId);
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' });

  const chooser =
    r.groups.length > 1 || r.users.length > 1 ? (
      <nav
        aria-label={r.users.length > 1 ? t('learners') : t('groups')}
        className="flex flex-wrap gap-1 text-sm"
      >
        {(r.users.length > 1 ? r.users : r.groups).map((x) => {
          const current = (r.users.length > 1 ? r.ref.userId : r.ref.groupId) === x.id;
          const p = new URLSearchParams(r.users.length > 1 ? { user: x.id } : { group: x.id });
          if (r.users.length > 1 && r.ref.groupId && r.groups.length > 1)
            p.set('group', r.ref.groupId);
          return (
            <Link
              key={x.id}
              href={`${base}?${p}`}
              aria-current={current ? 'page' : undefined}
              className="rounded-full border border-border px-2.5 py-0.5 hover:bg-muted aria-[current=page]:bg-secondary aria-[current=page]:font-semibold"
            >
              {x.name}
            </Link>
          );
        })}
      </nav>
    ) : null;

  if (sp.index === '1') {
    const idx = await wikiIndex(ctx, a, r.ref);
    return (
      <div className="grid max-w-3xl gap-4">
        {chooser}
        <h2 className="text-lg font-semibold">{t('allPages')}</h2>
        {idx.pages.length ? (
          <ul className="grid gap-1">
            {idx.pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={href({ page: p.id })} className="text-accent hover:underline">
                  {p.title}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t('versionShort', { n: p.version })} · {when(p.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noPages')}</p>
        )}
        {idx.orphans.length ? (
          <section aria-labelledby="wiki-orphans" className="grid gap-1">
            <h3 id="wiki-orphans" className="font-medium">
              {t('orphans')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('orphansHint')}</p>
            <ul className="list-disc pl-5 text-sm">
              {idx.orphans.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  const asked = sp.title ? normTitle(sp.title) : undefined;
  const page = await wikiPage(ctx, a, r.ref, { pageId: sp.page, title: asked });
  const title = page?.title ?? asked ?? firstTitle(a);
  const pageUrl = page ? href({ page: page.id }) : href({ title });
  const tabs = page
    ? [
        { key: 'view', label: t('view'), url: pageUrl, icon: null },
        ...(r.canEdit
          ? [
              {
                key: 'edit',
                label: t('edit'),
                url: href({ page: page.id, edit: '1' }),
                icon: Pencil,
              },
            ]
          : []),
        {
          key: 'history',
          label: t('history'),
          url: href({ page: page.id, history: '1' }),
          icon: History,
        },
      ]
    : [];
  const tab =
    sp.edit === '1' ? 'edit' : sp.history === '1' || sp.compare || sp.version ? 'history' : 'view';

  const header = (
    <div className="grid gap-3">
      {chooser}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{title}</h2>
        <Button asChild size="sm" variant="ghost">
          <Link href={href({ index: '1' })}>
            <ListTree aria-hidden />
            {t('allPages')}
          </Link>
        </Button>
      </div>
      {tabs.length ? (
        <nav aria-label={t('pageTabs')} className="flex flex-wrap gap-1">
          {tabs.map((x) => (
            <Button key={x.key} asChild size="sm" variant={tab === x.key ? 'secondary' : 'ghost'}>
              <Link href={x.url} aria-current={tab === x.key ? 'page' : undefined}>
                {x.label}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
    </div>
  );

  // a page not written yet: write it, or say so
  if (!page) {
    if (sp.page) return <Alert>{t('notFound')}</Alert>;
    return (
      <div className="grid max-w-3xl gap-4">
        {header}
        {r.canEdit && sp.edit === '1' ? (
          <WikiEditor
            activityId={a.id}
            courseId={course.id}
            pageId={null}
            title={title}
            content=""
            baseVersion={0}
            subwiki={r.ref}
            back={href({ title })}
            canOverride={canOverride}
          />
        ) : (
          <Card>
            <CardContent className="grid gap-3 pt-6">
              <p>{t('notWritten', { title })}</p>
              {r.canEdit ? (
                <Button asChild className="justify-self-start">
                  <Link href={href({ title, edit: '1' })}>{t('create')}</Link>
                </Button>
              ) : null}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  const links = (html: string) =>
    renderLinks(html, (x) =>
      page.ids[x]
        ? { url: href({ page: page.ids[x] }), exists: true }
        : { url: href({ title: x }), exists: false },
    );

  if (tab === 'edit' && r.canEdit)
    return (
      <div className="grid max-w-3xl gap-4">
        {header}
        <WikiEditor
          activityId={a.id}
          courseId={course.id}
          pageId={page.id}
          title={page.title}
          content={page.content}
          baseVersion={page.version}
          subwiki={r.ref}
          back={pageUrl}
          canOverride={canOverride}
        />
      </div>
    );

  if (tab === 'history') {
    const versions = await wikiHistory(ctx, a, page.id);
    const [from, to] = (sp.compare ?? '').split(',').map(Number);
    if (from && to) {
      const c = await wikiCompare(ctx, a, page.id, from, to);
      return (
        <div className="grid max-w-3xl gap-4">
          {header}
          <p className="text-sm text-muted-foreground">
            {t('comparing', {
              from: c.from.version,
              to: c.to.version,
            })}
          </p>
          <section
            className="whitespace-pre-wrap rounded-lg border border-border p-4 leading-relaxed"
            aria-label={t('changes')}
          >
            {c.parts.map((p, i) =>
              p.kind === 'same' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts of one text in order
                <span key={i}>{p.text}</span>
              ) : p.kind === 'added' ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts of one text in order
                <ins key={i} className="bg-success-soft text-success no-underline">
                  {p.text}
                </ins>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts of one text in order
                <del key={i} className="bg-destructive/10 text-destructive">
                  {p.text}
                </del>
              ),
            )}
          </section>
          <Link
            href={href({ page: page.id, history: '1' })}
            className="text-sm text-accent hover:underline"
          >
            {t('backToHistory')}
          </Link>
        </div>
      );
    }
    const shown = sp.version ? versions.find((v) => v.version === Number(sp.version)) : undefined;
    if (shown)
      return (
        <div className="grid max-w-3xl gap-4">
          {header}
          <Alert>
            {t('oldVersion', {
              n: shown.version,
              time: when(shown.createdAt),
              name: shown.author?.name ?? '—',
            })}
          </Alert>
          <RichText html={links(shown.content)} />
        </div>
      );
    return (
      <div className="grid max-w-3xl gap-4">
        {header}
        <ol className="grid gap-2">
          {versions.map((v, i) => (
            <li
              key={v.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span>
                <Link
                  href={href({ page: page.id, version: String(v.version) })}
                  className="font-medium text-accent hover:underline"
                >
                  {t('versionShort', { n: v.version })}
                </Link>{' '}
                · {when(v.createdAt)} · {v.author?.name ?? t('formerUser')}
              </span>
              <span className="flex gap-1">
                {versions[i + 1] ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      href={href({
                        page: page.id,
                        compare: `${versions[i + 1]!.version},${v.version}`,
                      })}
                    >
                      {t('compareWithPrevious')}
                    </Link>
                  </Button>
                ) : null}
                {r.canEdit && i > 0 ? (
                  <RestoreVersion
                    activityId={a.id}
                    pageId={page.id}
                    version={v.version}
                    back={pageUrl}
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="grid max-w-3xl gap-4">
      {header}
      {page.lockedBy ? <Alert>{t('beingEdited', { name: page.lockedBy })}</Alert> : null}
      <RichText html={links(page.content)} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t('lastChange', {
            n: page.version,
            time: when(page.updatedAt),
            name: page.author ?? t('formerUser'),
          })}
        </span>
        {r.manage ? (
          <DeletePage
            activityId={a.id}
            pageId={page.id}
            title={page.title}
            back={href({ index: '1' })}
          />
        ) : null}
      </div>
    </div>
  );
}
