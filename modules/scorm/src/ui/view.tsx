import type { ViewProps } from '@hubium/module-sdk/ui';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { currentAttempt, isCompleted, type ScormSettingsT, scorePercent } from '../server.ts';
import { NewAttemptButton, PackageUploader, ScormWatcher } from './client.tsx';

type Props = ViewProps<ScormSettingsT>;

const minutes = (sec: number) => `${Math.round(sec / 60)}`;

export async function ScormView({ activity: a, ctx, canManage, searchParams }: Props) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const [t, format] = await Promise.all([getTranslations('mod.scorm'), getFormatter()]);
  const pkg = await ctx.db.scormPackage.findUnique({
    where: { activityId: a.id },
    include: { scos: { orderBy: { sortOrder: 'asc' } } },
  });
  const canReport = await ctx.perm.can('mod.scorm:viewreports', a.id);

  if (canManage && searchParams.cmi) {
    const track = await ctx.db.scormTrack.findUnique({
      where: { id: searchParams.cmi },
      include: { attempt: { include: { user: { select: { name: true } } } }, sco: true },
    });
    if (track && track.attempt.activityId === a.id) {
      return (
        <div className="grid gap-3">
          <Link
            href={`/course/${a.courseId}/a/${a.id}`}
            className="text-sm text-accent hover:underline"
          >
            ← {t('back')}
          </Link>
          <h2 className="font-semibold">
            {t('cmiDebug')}: {track.attempt.user.name} · {track.sco.title} ·{' '}
            {t('attempt', { n: track.attempt.attemptNumber })}
          </h2>
          <pre className="max-h-[70vh] overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(track.cmi, null, 2)}
          </pre>
        </div>
      );
    }
  }

  const processing = pkg?.status === 'PROCESSING';
  let player: React.ReactNode = null;
  let summary: React.ReactNode = null;
  if (pkg?.status === 'READY' && me && pkg.scos.length) {
    const attempt = await currentAttempt(ctx.db, a.id, me);
    const tracks = await ctx.db.scormTrack.findMany({ where: { attemptId: attempt!.id } });
    const attempts = await ctx.db.scormAttempt.count({ where: { activityId: a.id, userId: me } });
    const outOfAttempts =
      !!attempt!.finishedAt && !!a.settings.maxAttempts && attempts >= a.settings.maxAttempts;
    const sco =
      pkg.scos.find((s) => s.id === searchParams.sco) ??
      pkg.scos.find((s) => !tracks.some((x) => x.scoId === s.id && isCompleted(x))) ??
      pkg.scos[0]!;
    const review = !!attempt!.finishedAt;
    const url = ctx.content.url(a.id, 'player', {
      data: { attempt: attempt!.id, sco: sco.id, ...(review ? { review: 1 } : {}) },
    });
    const track = tracks.find((x) => x.scoId === sco.id);
    const pct = attempt!.score;
    summary = (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="accent">{t('attempt', { n: attempt!.attemptNumber })}</Badge>
        <Badge variant={attempt!.finishedAt ? 'success' : 'warning'}>
          {attempt!.finishedAt ? t('finished') : track ? t('inProgress') : t('notStarted')}
        </Badge>
        {pct !== null && pct !== undefined ? (
          <span>{t('score', { score: Math.round(pct) })}</span>
        ) : null}
        {review ? <span className="text-muted-foreground">{t('reviewMode')}</span> : null}
        {attempt!.finishedAt && !outOfAttempts ? <NewAttemptButton activityId={a.id} /> : null}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent hover:underline"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t('openNewWindow')}
        </a>
      </div>
    );
    player = (
      <div className="grid gap-3 lg:grid-cols-[14rem_1fr]">
        {pkg.scos.length > 1 ? (
          <nav aria-label={t('contents')} className="grid content-start gap-1">
            {pkg.scos.map((s) => {
              const tr = tracks.find((x) => x.scoId === s.id);
              return (
                <Link
                  key={s.id}
                  href={`/course/${a.courseId}/a/${a.id}?sco=${s.id}`}
                  aria-current={s.id === sco.id ? 'page' : undefined}
                  className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm ${s.id === sco.id ? 'bg-accent-soft text-accent' : 'hover:bg-muted'}`}
                >
                  <span className="truncate">{s.title}</span>
                  {tr && isCompleted(tr) ? (
                    <span>
                      <span aria-hidden>✓</span>
                      <span className="sr-only">{t('finished')}</span>
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        ) : null}
        {a.settings.newWindow ? (
          <Card className={pkg.scos.length > 1 ? '' : 'lg:col-span-2'}>
            <CardContent className="pt-6">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 font-medium text-accent hover:underline"
              >
                <ExternalLink className="size-4" aria-hidden />
                {t('launch')}
              </a>
            </CardContent>
          </Card>
        ) : (
          <iframe
            src={url}
            title={sco.title}
            className={`w-full rounded-lg border border-border bg-white ${pkg.scos.length > 1 ? '' : 'lg:col-span-2'}`}
            style={{ height: a.settings.height }}
            allow="fullscreen; autoplay"
          />
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <ScormWatcher processing={processing} />
      {!pkg ? <Alert>{canManage ? t('noPackageManager') : t('noPackage')}</Alert> : null}
      {processing ? <Alert>{t('processing')}</Alert> : null}
      {pkg?.status === 'FAILED' ? (
        <Alert variant="destructive">{t('failed', { error: pkg.error ?? '' })}</Alert>
      ) : null}
      {summary}
      {player}
      {canManage ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t('package')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {pkg?.status === 'READY' ? (
              <p className="text-sm text-muted-foreground">
                {pkg.title} · {pkg.version === 'SCORM_12' ? 'SCORM 1.2' : 'SCORM 2004'} ·{' '}
                {t('scoCount', { n: pkg.scos.length })}
              </p>
            ) : null}
            <PackageUploader activityId={a.id} />
          </CardContent>
        </Card>
      ) : null}
      {canManage || canReport ? <Report ctx={ctx} a={a} format={format} t={t} /> : null}
    </div>
  );
}

async function Report({
  ctx,
  a,
  format,
  t,
}: {
  ctx: Props['ctx'];
  a: Props['activity'];
  format: Awaited<ReturnType<typeof getFormatter>>;
  t: Awaited<ReturnType<typeof getTranslations<'mod.scorm'>>>;
}) {
  const attempts = await ctx.db.scormAttempt.findMany({
    where: { activityId: a.id },
    include: {
      user: { select: { name: true } },
      tracks: { include: { sco: { select: { title: true } } } },
    },
    orderBy: [{ userId: 'asc' }, { attemptNumber: 'asc' }],
  });
  return (
    <section aria-labelledby="scorm-report" className="grid gap-3">
      <h2 id="scorm-report" className="text-lg font-semibold">
        {t('report')}
      </h2>
      {attempts.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('student')}</Th>
              <Th>{t('attemptCol')}</Th>
              <Th>{t('status')}</Th>
              <Th className="text-right">{t('scoreCol')}</Th>
              <Th className="text-right">{t('minutes')}</Th>
              <Th className="hidden md:table-cell">{t('lastAccess')}</Th>
            </Tr>
          </THead>
          <TBody>
            {attempts.flatMap((at) =>
              (at.tracks.length ? at.tracks : [null]).map((tr, i) => (
                <Tr key={`${at.id}-${tr?.id ?? i}`}>
                  <Td>{i === 0 ? at.user.name : ''}</Td>
                  <Td>
                    {at.attemptNumber}
                    {tr && at.tracks.length > 1 ? ` · ${tr.sco.title}` : ''}
                  </Td>
                  <Td>
                    {tr ? (
                      <Link
                        href={`/course/${a.courseId}/a/${a.id}?cmi=${tr.id}`}
                        className="hover:underline"
                        title={t('cmiDebug')}
                      >
                        {tr.completionStatus}
                        {tr.successStatus !== 'unknown' && tr.successStatus !== tr.completionStatus
                          ? ` / ${tr.successStatus}`
                          : ''}
                      </Link>
                    ) : (
                      t('notStarted')
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {tr && scorePercent(tr) !== null ? `${Math.round(scorePercent(tr)!)}%` : '—'}
                  </Td>
                  <Td className="text-right tabular-nums">{tr ? minutes(tr.totalTimeSec) : '—'}</Td>
                  <Td className="hidden text-sm text-muted-foreground md:table-cell">
                    {format.relativeTime(at.lastAccessAt)}
                  </Td>
                </Tr>
              )),
            )}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noAttempts')}</p>
      )}
    </section>
  );
}
