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
import { getFormatter, getTranslations } from 'next-intl/server';
import { gradeOf, type H5pSettingsT, PLAYER_STRINGS } from '../server.ts';
import { H5pFrame, PackageUploader, ProcessingWatcher } from './client.tsx';

type Props = ViewProps<H5pSettingsT>;
type T = Awaited<ReturnType<typeof getTranslations<'mod.h5p'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const points = (raw: number | null, max: number | null) =>
  raw === null ? '—' : max === null ? `${raw}` : `${raw} / ${max}`;
const time = (sec: number | null) =>
  sec === null ? '—' : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export async function H5pView({ activity: a, ctx, canManage }: Props) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : null;
  const [t, tp, format] = await Promise.all([
    getTranslations('mod.h5p'),
    getTranslations('mod.h5p.player'),
    getFormatter(),
  ]);
  const pkg = await ctx.db.h5pPackage.findUnique({ where: { activityId: a.id } });
  const [canSubmit, canReport] = await Promise.all([
    ctx.perm.can('mod.h5p:submit', a.id),
    ctx.perm.can('mod.h5p:viewreports', a.id),
  ]);
  const tracked = a.settings.tracking && canSubmit;

  let player: React.ReactNode = null;
  if (pkg?.status === 'READY' && me) {
    const words = Object.fromEntries(PLAYER_STRINGS.map((k) => [k, tp(k)]));
    const src = `${ctx.content.url(a.id, 'player', { data: { track: tracked ? 1 : 0 } })}#${encodeURIComponent(JSON.stringify(words))}`;
    player = (
      <div className="grid gap-2">
        {tracked ? null : <p className="text-sm text-muted-foreground">{t('preview')}</p>}
        <H5pFrame src={src} title={pkg.title || a.name} origin={new URL(src).origin} />
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {pkg?.status === 'PROCESSING' ? <ProcessingWatcher /> : null}
      {!pkg ? <Alert>{canManage ? t('noPackageManager') : t('noPackage')}</Alert> : null}
      {pkg?.status === 'PROCESSING' ? <Alert>{t('processing')}</Alert> : null}
      {pkg?.status === 'FAILED' ? (
        <Alert variant="destructive">{t('failed', { error: pkg.error ?? '' })}</Alert>
      ) : null}
      {player}
      {tracked && me ? <MyAttempts ctx={ctx} a={a} me={me} t={t} format={format} /> : null}
      {canManage ? (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t('package')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {pkg?.status === 'READY' ? (
              <p className="text-sm text-muted-foreground">
                {pkg.title} · {pkg.mainLibrary}
              </p>
            ) : null}
            <PackageUploader activityId={a.id} />
          </CardContent>
        </Card>
      ) : null}
      {a.settings.tracking && (canManage || canReport) ? (
        <Report ctx={ctx} a={a} t={t} format={format} />
      ) : null}
    </div>
  );
}

async function MyAttempts({
  ctx,
  a,
  me,
  t,
  format,
}: {
  ctx: Props['ctx'];
  a: Props['activity'];
  me: string;
  t: T;
  format: Format;
}) {
  const attempts = await ctx.db.h5pAttempt.findMany({
    where: { activityId: a.id, userId: me },
    orderBy: { attemptNumber: 'asc' },
  });
  if (!attempts.length) return null;
  const g = gradeOf(
    a.settings.gradeMethod,
    attempts.map((x) => x.scaled),
  );
  return (
    <section aria-labelledby="h5p-mine" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="h5p-mine" className="text-lg font-semibold">
          {t('myAttempts')}
        </h2>
        {g === null ? null : (
          <span className="text-sm">
            {t('grade', {
              grade: format.number(g * a.settings.gradeMax, { maximumFractionDigits: 2 }),
              max: a.settings.gradeMax,
            })}
          </span>
        )}
      </div>
      <Table>
        <THead>
          <Tr>
            <Th>{t('attempt')}</Th>
            <Th className="text-right">{t('score')}</Th>
            <Th>{t('result')}</Th>
            <Th className="hidden text-right sm:table-cell">{t('duration')}</Th>
            <Th className="hidden md:table-cell">{t('when')}</Th>
          </Tr>
        </THead>
        <TBody>
          {attempts.map((x) => (
            <Tr key={x.id}>
              <Td>{x.attemptNumber}</Td>
              <Td className="text-right tabular-nums">
                {points(x.rawScore, x.maxScore)} ({pct(x.scaled)})
              </Td>
              <Td>
                {x.success === null ? (
                  '—'
                ) : (
                  <Badge variant={x.success ? 'success' : 'warning'}>
                    {x.success ? t('passed') : t('notPassed')}
                  </Badge>
                )}
              </Td>
              <Td className="hidden text-right tabular-nums sm:table-cell">
                {time(x.durationSec)}
              </Td>
              <Td className="hidden text-sm text-muted-foreground md:table-cell">
                {format.dateTime(x.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

async function Report({
  ctx,
  a,
  t,
  format,
}: {
  ctx: Props['ctx'];
  a: Props['activity'];
  t: T;
  format: Format;
}) {
  const attempts = await ctx.db.h5pAttempt.findMany({
    where: { activityId: a.id },
    include: { user: { select: { id: true, name: true } } },
    orderBy: [{ userId: 'asc' }, { attemptNumber: 'asc' }],
  });
  const byUser = new Map<string, typeof attempts>();
  for (const x of attempts) byUser.set(x.userId, [...(byUser.get(x.userId) ?? []), x]);
  const rows = [...byUser.values()].sort((p, q) => p[0]!.user.name.localeCompare(q[0]!.user.name));
  return (
    <section aria-labelledby="h5p-report" className="grid gap-3">
      <h2 id="h5p-report" className="text-lg font-semibold">
        {t('report')}
      </h2>
      {rows.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('student')}</Th>
              <Th className="text-right">{t('attempts')}</Th>
              <Th className="text-right">{t('gradeCol')}</Th>
              <Th className="hidden md:table-cell">{t('lastAttempt')}</Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map((xs) => {
              const g = gradeOf(
                a.settings.gradeMethod,
                xs.map((x) => x.scaled),
              );
              return (
                <Tr key={xs[0]!.userId}>
                  <Td>{xs[0]!.user.name}</Td>
                  <Td className="text-right tabular-nums">{xs.length}</Td>
                  <Td className="text-right tabular-nums">
                    {g === null
                      ? '—'
                      : format.number(g * a.settings.gradeMax, { maximumFractionDigits: 2 })}
                  </Td>
                  <Td className="hidden text-sm text-muted-foreground md:table-cell">
                    {format.relativeTime(xs.at(-1)!.createdAt)}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noAttempts')}</p>
      )}
    </section>
  );
}
