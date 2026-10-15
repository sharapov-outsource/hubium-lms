import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Card, CardContent, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { CalendarClock, PlayCircle } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import { canJoinAt, type LiveSettingsT, providerConfigured, sessionWindow } from '../server.ts';
import { JoinButton, ModeratorButtons, RecordingToggle } from './client.tsx';

type Props = ViewProps<LiveSettingsT>;

export async function LiveView({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.livesession'), getFormatter()]);
  const now = new Date();
  const [moderator, canJoin, meeting, recordings] = await Promise.all([
    ctx.perm.can('mod.livesession:moderate', a.id),
    ctx.perm.can('mod.livesession:join', a.id),
    ctx.db.liveMeeting.findUnique({ where: { activityId: a.id } }),
    ctx.db.liveRecording.findMany({ where: { activityId: a.id }, orderBy: { startedAt: 'desc' } }),
  ]);
  // participants see the recordings shown; moderators all, to show or hide them
  const listed = moderator ? recordings : recordings.filter((r) => r.published);
  const w = sessionWindow(a.settings);
  const status = meeting?.status ?? 'SCHEDULED';
  const when = canJoinAt(a.settings, now, moderator);
  const configured = providerConfigured(a.settings.provider);
  const range = `${format.dateTime(w.start, { dateStyle: 'full', timeStyle: 'short' })} – ${format.dateTime(w.endsAt, { timeStyle: 'short' })}`;
  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <CalendarClock className="size-5 text-muted-foreground" aria-hidden />
            <span className="font-medium">{range}</span>
            <Badge
              variant={status === 'LIVE' ? 'success' : status === 'ENDED' ? 'neutral' : 'accent'}
            >
              {t(`status.${status}`)}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {a.settings.provider === 'bbb' ? 'BigBlueButton' : 'Jitsi Meet'}
            </span>
          </div>
          {!configured ? (
            <Alert variant="warning">{t('notConfigured')}</Alert>
          ) : canJoin && when === 'ok' && (status !== 'ENDED' || moderator) ? (
            <div className="flex flex-wrap items-center gap-3">
              <JoinButton activityId={a.id} label={moderator ? t('startOrJoin') : t('join')} />
              {!moderator && status !== 'LIVE' && a.settings.provider === 'bbb' ? (
                <span className="text-sm text-muted-foreground">{t('waitingTeacher')}</span>
              ) : null}
            </div>
          ) : when === 'early' ? (
            <p className="text-sm text-muted-foreground">
              {t('opensAt', { time: format.relativeTime(w.opensAt, now) })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('over')}</p>
          )}
          {moderator ? (
            <ModeratorButtons
              activityId={a.id}
              live={status === 'LIVE'}
              record={a.settings.record && a.settings.provider === 'bbb'}
            />
          ) : null}
        </CardContent>
      </Card>
      {listed.length ? (
        <section aria-labelledby="ls-rec" className="grid gap-2">
          <h2 id="ls-rec" className="text-lg font-semibold">
            {t('recordings')}
          </h2>
          <ul className="grid gap-2">
            {listed.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-accent hover:underline"
                >
                  <PlayCircle className="size-4" aria-hidden />
                  {r.startedAt
                    ? format.dateTime(r.startedAt, { dateStyle: 'medium', timeStyle: 'short' })
                    : r.recordId}
                  {r.durationSec ? ` · ${Math.round(r.durationSec / 60)} ${t('min')}` : ''}
                </a>
                {moderator ? (
                  <>
                    {r.published ? null : <Badge variant="warning">{t('recordingHidden')}</Badge>}
                    <RecordingToggle activityId={a.id} id={r.id} published={r.published} />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {moderator ? <Attendance ctx={ctx} activityId={a.id} format={format} t={t} /> : null}
    </div>
  );
}

async function Attendance({
  ctx,
  activityId,
  format,
  t,
}: {
  ctx: Props['ctx'];
  activityId: string;
  format: Awaited<ReturnType<typeof getFormatter>>;
  t: Awaited<ReturnType<typeof getTranslations<'mod.livesession'>>>;
}) {
  const rows = await ctx.db.liveAttendance.findMany({
    where: { activityId },
    include: { user: { select: { name: true } } },
    orderBy: { firstJoinAt: 'asc' },
  });
  return (
    <section aria-labelledby="ls-att" className="grid gap-2">
      <h2 id="ls-att" className="text-lg font-semibold">
        {t('attendance')} ({rows.length})
      </h2>
      {rows.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('participant')}</Th>
              <Th>{t('firstJoin')}</Th>
              <Th className="text-right">{t('joins')}</Th>
              <Th className="text-right">{t('minutes')}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  {r.user.name}
                  {r.moderator ? <Badge className="ml-2">{t('moderator')}</Badge> : null}
                </Td>
                <Td className="text-sm">
                  {format.dateTime(r.firstJoinAt, { timeStyle: 'short' })}
                </Td>
                <Td className="text-right tabular-nums">{r.joins}</Td>
                <Td className="text-right tabular-nums">{Math.round(r.durationSec / 60)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noAttendance')}</p>
      )}
    </section>
  );
}
