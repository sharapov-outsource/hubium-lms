import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Badge, Button, EmptyState } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { type BookSettingsT, type Chapter, chapterNumbers, visibleChapters } from '../server.ts';
import { ChapterForm, ChapterTools, PrintButton } from './client.tsx';

type Props = ViewProps<BookSettingsT>;

export async function BookView({ activity: a, course, ctx, searchParams: sp }: Props) {
  const t = await getTranslations('mod.book');
  const [list, canEdit] = await Promise.all([
    visibleChapters(ctx, a),
    ctx.perm.can('mod.book:edit', a.id),
  ]);
  const base = `/course/${course.id}/a/${a.id}`;
  const numbers = chapterNumbers(list);
  const { numbering, customTitles } = a.settings;
  const label = (c: Chapter) => {
    const n = numbers.get(c.id)!;
    if (numbering === 'numbers') return `${n}. ${c.title}`;
    if (numbering === 'bullets' && c.subchapter) return `• ${c.title}`;
    return c.title;
  };
  const indent = (c: Chapter) => c.subchapter && numbering !== 'none';

  if (sp.print === '1')
    return (
      <div className="grid max-w-3xl gap-8">
        <div className="flex flex-wrap items-center gap-3 print:hidden">
          <PrintButton label={t('print')} />
          <Link href={base} className="text-sm text-accent hover:underline">
            {t('backToBook')}
          </Link>
        </div>
        {list.map((c) => (
          <section key={c.id} aria-label={label(c)} className="grid gap-2 break-inside-avoid-page">
            {customTitles ? null : (
              <h2 className={cn('font-semibold', c.subchapter ? 'text-lg' : 'text-xl')}>
                {label(c)}
              </h2>
            )}
            <RichText html={c.content} />
          </section>
        ))}
      </div>
    );

  if (canEdit && (sp.add === '1' || (sp.edit === '1' && sp.chapter))) {
    const editing = sp.edit === '1' ? list.find((c) => c.id === sp.chapter) : undefined;
    return (
      <div className="grid max-w-3xl gap-4">
        <h2 className="text-lg font-semibold">
          {editing ? t('editChapter') : sp.sub === '1' ? t('addSubchapter') : t('addChapter')}
        </h2>
        <ChapterForm
          activityId={a.id}
          courseId={course.id}
          base={base}
          chapter={editing}
          afterId={editing ? undefined : (sp.after ?? null)}
          subchapter={editing ? editing.subchapter : sp.sub === '1'}
          first={editing ? list[0]?.id === editing.id : !list.length}
        />
      </div>
    );
  }

  if (!list.length)
    return (
      <EmptyState
        title={canEdit ? t('emptyEditor') : t('empty')}
        action={
          canEdit ? (
            <Button asChild>
              <Link href={`${base}?add=1`}>{t('addChapter')}</Link>
            </Button>
          ) : undefined
        }
      />
    );

  const i = Math.max(
    0,
    list.findIndex((c) => c.id === sp.chapter),
  );
  const current = list[i]!;
  const prev = list[i - 1];
  const next = list[i + 1];
  const toc = (
    <ol className="grid gap-0.5 text-sm">
      {list.map((c) => (
        <li key={c.id} className={cn(indent(c) && 'pl-4')}>
          <Link
            href={`${base}?chapter=${c.id}`}
            aria-current={c.id === current.id ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1',
              c.id === current.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-muted',
            )}
          >
            <span className="min-w-0 break-words">{label(c)}</span>
            {c.hidden ? <Badge variant="neutral">{t('hidden')}</Badge> : null}
          </Link>
        </li>
      ))}
    </ol>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav aria-label={t('toc')} className="grid content-start gap-3">
        <details className="rounded-lg border border-border p-2 lg:hidden">
          <summary className="cursor-pointer px-2 py-1 text-sm font-medium">{t('toc')}</summary>
          <div className="pt-2">{toc}</div>
        </details>
        <div className="hidden lg:block">
          <h2 className="mb-2 px-2 text-sm font-semibold">{t('toc')}</h2>
          {toc}
        </div>
        <div className="flex flex-wrap gap-2 px-2">
          <Link
            href={`${base}?print=1`}
            className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
          >
            <Printer className="size-4" aria-hidden />
            {t('printBook')}
          </Link>
        </div>
      </nav>
      <article className="grid min-w-0 content-start gap-4">
        {canEdit ? (
          <ChapterTools
            activityId={a.id}
            base={base}
            chapter={{ id: current.id, title: current.title, hidden: current.hidden }}
            first={i === 0}
            last={i === list.length - 1}
          />
        ) : null}
        {customTitles ? null : (
          <h2 className="text-xl font-semibold">
            {label(current)}
            {current.hidden ? (
              <Badge variant="neutral" className="ml-2 align-middle">
                {t('hidden')}
              </Badge>
            ) : null}
          </h2>
        )}
        <RichText html={current.content} className="max-w-3xl" />
        <nav
          aria-label={t('chapterNav')}
          className="flex flex-wrap justify-between gap-2 border-t border-border pt-4"
        >
          {prev ? (
            <Button asChild variant="outline">
              <Link href={`${base}?chapter=${prev.id}`} rel="prev">
                <ChevronLeft aria-hidden />
                <span className="sr-only">{t('prev')}: </span>
                <span className="max-w-48 truncate">{prev.title}</span>
              </Link>
            </Button>
          ) : (
            <span />
          )}
          {next ? (
            <Button asChild variant="outline">
              <Link href={`${base}?chapter=${next.id}`} rel="next">
                <span className="sr-only">{t('next')}: </span>
                <span className="max-w-48 truncate">{next.title}</span>
                <ChevronRight aria-hidden />
              </Link>
            </Button>
          ) : null}
        </nav>
      </article>
    </div>
  );
}
