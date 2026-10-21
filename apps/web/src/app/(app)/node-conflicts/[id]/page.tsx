import { getConflict } from '@hubium/core/node/conflicts';
import type { Locale } from '@hubium/i18n';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { conflictReason } from '@/components/node-conflicts';
import { titled } from '@/server/page-title';
import { getContext, orRefused, requireUser } from '@/server/session';
import { ConflictActions } from './conflict-actions';

export const generateMetadata = titled('nodes', 'conflictTitle');

/**
 * Work done on a local node without a connection that the cloud did not take: its author
 * reads what they did (the text of a post, the answers of an attempt), a teacher or an
 * administrator decides whether the cloud takes it after all.
 */
export default async function NodeConflictPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireUser();
  const ctx = await getContext();
  const [t, format, locale, c] = await Promise.all([
    getTranslations('nodes'),
    getFormatter(),
    getLocale(),
    orRefused(getConflict(ctx, id)),
  ]);
  const op = c.op as { at: string; input: unknown };
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title={t('conflictTitle')} description={t('conflictDescription')} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            {conflictReason(c.reason, locale as Locale)}
            <Badge
              variant={
                c.status === 'OPEN' ? 'warning' : c.status === 'ACCEPTED' ? 'success' : 'neutral'
              }
            >
              {t(`conflictStatus.${c.status}`)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">{t('node')}</dt>
            <dd>{c.node.name}</dd>
            <dt className="text-muted-foreground">{t('author')}</dt>
            <dd>{c.actor?.name ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('doneAt')}</dt>
            <dd>
              {format.dateTime(new Date(op.at), { dateStyle: 'medium', timeStyle: 'medium' })}
            </dd>
            {c.activity ? (
              <>
                <dt className="text-muted-foreground">{t('activity')}</dt>
                <dd>
                  <Link
                    href={`/course/${c.activity.courseId}/a/${c.activity.id}`}
                    className="text-accent hover:underline"
                  >
                    {c.activity.name}
                  </Link>
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('what')}</dt>
            <dd>
              <code className="text-xs">{c.name}</code>
            </dd>
          </dl>
          <details>
            <summary className="cursor-pointer font-medium">{t('content')}</summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(op.input, null, 2)}
            </pre>
          </details>
          {c.canDecide && c.status === 'OPEN' ? (
            <div className="grid gap-2">
              <p className="text-muted-foreground">{t('decideHint')}</p>
              <ConflictActions id={c.id} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
