import type { ViewProps } from '@hubium/module-sdk/ui';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Progress,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { Interval } from '../media.ts';
import { parseEmbed, type VideoOutputs, type VideoSettingsT, watchReport } from '../server.ts';
import {
  CaptionsManager,
  EmbedPlayer,
  HlsPlayer,
  RetranscodeButton,
  StatusWatcher,
  VideoUploader,
} from './client.tsx';

type Props = ViewProps<VideoSettingsT>;

const fmtDuration = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export async function VideoView({ activity: a, ctx, canManage }: Props) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const [t, format] = await Promise.all([getTranslations('mod.video'), getFormatter()]);
  const [asset, progress, captionFiles, canReport] = await Promise.all([
    ctx.db.videoAsset.findUnique({ where: { activityId: a.id }, include: { captions: true } }),
    me
      ? ctx.db.videoProgress.findUnique({
          where: { activityId_userId: { activityId: a.id, userId: me } },
        })
      : null,
    ctx.files.list(a.id, 'captions'),
    ctx.perm.can('mod.video:viewprogress', a.id),
  ]);
  const captions = (asset?.captions ?? []).flatMap((c) => {
    const f = captionFiles.find((x) => x.id === c.fileId);
    return f ? [{ lang: c.lang, label: c.label, url: f.url }] : [];
  });
  const outputs = (asset?.outputs ?? {}) as VideoOutputs;
  const base = `/api/mod/video/${a.id}/hls`;
  const initial = (progress?.intervals ?? []) as Interval[];
  const embed = a.settings.source === 'embed' ? parseEmbed(a.settings.embedUrl) : null;
  const processing = asset?.status === 'UPLOADED' || asset?.status === 'PROCESSING';

  const player = embed ? (
    <EmbedPlayer
      activityId={a.id}
      provider={embed.provider}
      embedUrl={embed.embedUrl}
      noSeekAhead={a.settings.noSeekAhead}
      initial={initial}
      title={a.name}
    />
  ) : asset?.status === 'READY' && outputs.master ? (
    <HlsPlayer
      activityId={a.id}
      src={`${base}/${outputs.master}`}
      poster={outputs.poster ? `${base}/${outputs.poster}` : undefined}
      sprite={outputs.sprite ? `${base}/${outputs.sprite}` : undefined}
      captions={captions}
      noSeekAhead={a.settings.noSeekAhead}
      initial={initial}
      initialPosition={progress?.position ?? 0}
      title={a.name}
    />
  ) : (
    <Alert>{processing ? t('processing') : t('notReady')}</Alert>
  );

  return (
    <div className="grid gap-6">
      <div className="max-w-4xl">{player}</div>
      {progress && !canManage ? (
        <Progress
          value={Math.round(progress.percent)}
          label={t('watched', { percent: Math.round(progress.percent) })}
          className="max-w-md"
        />
      ) : null}
      {canManage && a.settings.source === 'upload' ? (
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>{t('manage')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {asset ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge
                  variant={
                    asset.status === 'READY'
                      ? 'success'
                      : asset.status === 'FAILED'
                        ? 'destructive'
                        : 'warning'
                  }
                >
                  {t(`status.${asset.status}`)}
                  {asset.status === 'PROCESSING' ? ` ${asset.progress}%` : ''}
                </Badge>
                {asset.durationSec ? <span>{fmtDuration(asset.durationSec)}</span> : null}
                {asset.height ? (
                  <span>
                    {asset.width}×{asset.height}
                  </span>
                ) : null}
                {outputs.renditions?.length ? (
                  <span className="text-muted-foreground">
                    {outputs.renditions.map((r) => `${r.height}p`).join(' · ')}
                  </span>
                ) : null}
                {asset.status === 'FAILED' || asset.status === 'READY' ? (
                  asset.sourceFileId ? (
                    <RetranscodeButton activityId={a.id} />
                  ) : null
                ) : null}
              </div>
            ) : null}
            {asset?.status === 'FAILED' && asset.error ? (
              <Alert variant="destructive" className="whitespace-pre-wrap text-xs">
                {asset.error.slice(-600)}
              </Alert>
            ) : null}
            <StatusWatcher activityId={a.id} active={processing} />
            <VideoUploader activityId={a.id} hasVideo={!!asset?.sourceFileId} />
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold">{t('captions')}</h3>
              <CaptionsManager activityId={a.id} captions={captions} />
            </div>
          </CardContent>
        </Card>
      ) : null}
      {canReport ? <WatchReport ctx={ctx} activityId={a.id} format={format} t={t} /> : null}
    </div>
  );
}

async function WatchReport({
  ctx,
  activityId,
  format,
  t,
}: {
  ctx: Props['ctx'];
  activityId: string;
  format: Awaited<ReturnType<typeof getFormatter>>;
  t: Awaited<ReturnType<typeof getTranslations<'mod.video'>>>;
}) {
  const rows = await watchReport(ctx, { id: activityId });
  return (
    <section aria-labelledby="watch-report" className="grid max-w-4xl gap-3">
      <h2 id="watch-report" className="text-lg font-semibold">
        {t('report')}
      </h2>
      {rows.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('student')}</Th>
              <Th className="w-56">{t('progress')}</Th>
              <Th className="hidden sm:table-cell">{t('lastWatched')}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>{r.name}</Td>
                <Td>
                  <Progress value={Math.round(r.percent)} label={`${Math.round(r.percent)}%`} />
                </Td>
                <Td className="hidden text-sm text-muted-foreground sm:table-cell">
                  {r.updatedAt ? format.relativeTime(r.updatedAt) : '—'}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noStudents')}</p>
      )}
    </section>
  );
}
