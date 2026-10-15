import { courseEventLog, getCourseAccess } from '@hubium/core';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { dateParam, textParam, uuidParam } from '@/lib/url-params';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('course', 'tabs.reports');

/** The participation report's periods, in days; 0 is all the event log keeps. */
const PERIODS = [30, 90, 365, 0];

/** The event names the packs name, from their nested messages (`activity.viewed`, …). */
function eventNames(tree: unknown, prefix = ''): string[] {
  if (typeof tree === 'string') return [prefix];
  if (!tree || typeof tree !== 'object') return [];
  return Object.entries(tree).flatMap(([k, v]) => eventNames(v, prefix ? `${prefix}.${k}` : k));
}

type Search = {
  days?: string;
  who?: string;
  event?: string;
  activity?: string;
  from?: string;
  to?: string;
  before?: string;
};

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<Search>;
}) {
  const { courseId } = await params;
  const sp = await searchParams;
  const asked = Number(sp.days);
  const days = PERIODS.includes(asked) ? asked : 90;
  const since = days ? new Date(Date.now() - days * 86_400_000) : new Date(0);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canViewReports) forbidden();
  const [t, tm, tc, format] = await Promise.all([
    getTranslations('reports'),
    getTranslations('mod'),
    getTranslations('common'),
    getFormatter(),
  ]);
  const student = await db.role.findUnique({ where: { shortName: 'student' } });
  const learners = await db.roleAssignment.findMany({
    where: { contextId: courseId, roleId: student?.id },
    select: { userId: true },
  });
  const learnerIds = learners.map((l) => l.userId);
  const [activities, views] = await Promise.all([
    db.activity.findMany({
      where: { courseId, deletedAt: null, moduleKey: { not: 'label' } },
      orderBy: [{ section: { rank: 'asc' } }, { rank: 'asc' }],
      select: { id: true, name: true, moduleKey: true },
    }),
    db.eventLog.groupBy({
      by: ['contextId'],
      where: {
        courseId,
        name: 'activity.viewed',
        actorId: { in: learnerIds },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
  ]);
  const distinct = await db.$queryRaw<{ contextId: string; n: bigint }[]>`
    SELECT "contextId", count(DISTINCT "actorId")::bigint AS n FROM "EventLog"
     WHERE "courseId" = ${courseId}::uuid AND name = 'activity.viewed' AND "actorId" = ANY(${learnerIds}::uuid[])
       AND "createdAt" >= ${since}
     GROUP BY "contextId"`;
  const canLogs = await ctx.perm.can('report:logs', courseId);
  const known = eventNames(t.raw('events'));
  const filter = {
    who: textParam(sp.who),
    name: sp.event && known.includes(sp.event) ? sp.event : undefined,
    activityId: uuidParam(sp.activity),
    from: dateParam(sp.from),
    to: dateParam(sp.to),
  };
  const logs = canLogs
    ? await courseEventLog(ctx, courseId, {
        who: filter.who,
        name: filter.name,
        activityId: filter.activityId,
        from: filter.from ? new Date(filter.from) : undefined,
        // the whole of the last day
        to: filter.to ? new Date(new Date(filter.to).getTime() + 86_400_000) : undefined,
        before: sp.before,
      })
    : { items: [], next: null };
  const activityName = new Map(activities.map((a) => [a.id, a.name]));
  const logHref = (more: Record<string, string | undefined>) => {
    const q = new URLSearchParams(
      Object.entries({
        days: String(days),
        who: filter.who,
        event: filter.name,
        activity: filter.activityId,
        from: filter.from,
        to: filter.to,
        ...more,
      }).filter((e): e is [string, string] => !!e[1]),
    );
    return `/course/${courseId}/reports?${q}#logs`;
  };
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('participation')}</CardTitle>
          <CardDescription>{t('participationHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <nav aria-label={t('period')} className="flex flex-wrap gap-1 text-sm">
            {PERIODS.map((d) => (
              <Link
                key={d}
                href={`/course/${courseId}/reports?days=${d}`}
                aria-current={d === days ? 'page' : undefined}
                className={
                  d === days
                    ? 'rounded-md bg-secondary px-2 py-1 font-medium'
                    : 'rounded-md px-2 py-1 text-accent hover:underline'
                }
              >
                {d ? t('lastDays', { n: d }) : t('allTime')}
              </Link>
            ))}
          </nav>
          <Table>
            <THead>
              <Tr>
                <Th>{t('activity')}</Th>
                <Th className="text-right">{t('views')}</Th>
                <Th className="text-right">{t('users')}</Th>
              </Tr>
            </THead>
            <TBody>
              {activities.map((a) => {
                const v = views.find((x) => x.contextId === a.id)?._count._all ?? 0;
                const u = Number(distinct.find((x) => x.contextId === a.id)?.n ?? 0);
                return (
                  <Tr key={a.id}>
                    <Td>
                      {a.name}{' '}
                      <span className="text-xs text-muted-foreground">
                        · {tm(`${a.moduleKey}.name` as never)}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{v}</Td>
                    <Td className="text-right tabular-nums">
                      {u} / {learnerIds.length}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      {canLogs ? (
        <Card id="logs">
          <CardHeader>
            <CardTitle>{t('logs')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <form
              action={`/course/${courseId}/reports#logs`}
              className="flex flex-wrap items-end gap-3"
              aria-label={t('logsFilter')}
            >
              <input type="hidden" name="days" value={days} />
              <Field label={t('who')} htmlFor="log-who">
                <Input id="log-who" name="who" defaultValue={filter.who} className="w-48" />
              </Field>
              <Field label={t('event')} htmlFor="log-event">
                <Select
                  id="log-event"
                  name="event"
                  defaultValue={filter.name ?? ''}
                  className="w-56"
                >
                  <option value="">{t('anyEvent')}</option>
                  {known.map((k) => (
                    <option key={k} value={k}>
                      {t(`events.${k}` as never)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('activity')} htmlFor="log-activity">
                <Select
                  id="log-activity"
                  name="activity"
                  defaultValue={filter.activityId ?? ''}
                  className="w-56"
                >
                  <option value="">{t('anyActivity')}</option>
                  {activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('from')} htmlFor="log-from">
                <Input
                  id="log-from"
                  type="date"
                  name="from"
                  defaultValue={filter.from}
                  className="w-40"
                />
              </Field>
              <Field label={t('to')} htmlFor="log-to">
                <Input
                  id="log-to"
                  type="date"
                  name="to"
                  defaultValue={filter.to}
                  className="w-40"
                />
              </Field>
              <Button type="submit" variant="secondary">
                {tc('apply')}
              </Button>
            </form>
            {logs.items.length === 0 ? (
              <EmptyState title={t('noLogs')} />
            ) : (
              <Table>
                <THead>
                  <Tr>
                    <Th>{t('time')}</Th>
                    <Th>{t('user')}</Th>
                    <Th>{t('event')}</Th>
                    <Th>{t('activity')}</Th>
                  </Tr>
                </THead>
                <TBody>
                  {logs.items.map((l) => (
                    <Tr key={l.id}>
                      <Td className="whitespace-nowrap text-muted-foreground">
                        {format.dateTime(l.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
                      </Td>
                      <Td>{l.actor ?? '—'}</Td>
                      <Td>
                        {/* an event the packs do not name shows its code */}
                        {t.has(`events.${l.name}` as never) ? (
                          t(`events.${l.name}` as never)
                        ) : (
                          <span className="font-mono text-xs">{l.name}</span>
                        )}
                      </Td>
                      <Td>{(l.contextId && activityName.get(l.contextId)) || '—'}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
            {sp.before || logs.next ? (
              <nav className="flex justify-between gap-2 text-sm" aria-label={t('logs')}>
                {sp.before ? (
                  <Link href={logHref({})} className="text-accent hover:underline">
                    {t('latestLogs')}
                  </Link>
                ) : (
                  <span />
                )}
                {logs.next ? (
                  <Link
                    href={logHref({ before: logs.next })}
                    className="text-accent hover:underline"
                  >
                    {t('earlierLogs')}
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
