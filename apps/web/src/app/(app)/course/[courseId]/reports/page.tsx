import { getCourseAccess } from '@hubium/core';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export default async function ReportsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canViewReports) forbidden();
  const [t, tm, format] = await Promise.all([
    getTranslations('reports'),
    getTranslations('mod'),
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
      where: { courseId, name: 'activity.viewed', actorId: { in: learnerIds } },
      _count: { _all: true },
    }),
  ]);
  const distinct = await db.$queryRaw<{ contextId: string; n: bigint }[]>`
    SELECT "contextId", count(DISTINCT "actorId")::bigint AS n FROM "EventLog"
     WHERE "courseId" = ${courseId}::uuid AND name = 'activity.viewed' AND "actorId" = ANY(${learnerIds}::uuid[])
     GROUP BY "contextId"`;
  const canLogs = await ctx.perm.can('report:logs', courseId);
  const logs = canLogs
    ? await db.eventLog.findMany({ where: { courseId }, orderBy: { createdAt: 'desc' }, take: 50 })
    : [];
  const actorNames = canLogs
    ? new Map(
        (
          await db.user.findMany({
            where: {
              id: { in: [...new Set(logs.map((l) => l.actorId).filter((x): x is string => !!x))] },
            },
            select: { id: true, name: true },
          })
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('participation')}</CardTitle>
          <CardDescription>{t('participationHint')}</CardDescription>
        </CardHeader>
        <CardContent>
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
        <Card>
          <CardHeader>
            <CardTitle>{t('logs')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <Tr>
                  <Th>{t('time')}</Th>
                  <Th>{t('user')}</Th>
                  <Th>{t('event')}</Th>
                </Tr>
              </THead>
              <TBody>
                {logs.map((l) => (
                  <Tr key={String(l.id)}>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      {format.dateTime(l.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
                    </Td>
                    <Td>{l.actorId ? (actorNames.get(l.actorId) ?? '—') : '—'}</Td>
                    <Td className="font-mono text-xs">{l.name}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
