import { Card, CardContent, PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';

export default async function AdminOverview() {
  const t = await getTranslations('admin');
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const [users, active, courses, enrolments] = await Promise.all([
    db.user.count({ where: { deletedAt: null, kind: 'PERSON' } }),
    db.user.count({ where: { deletedAt: null, lastLoginAt: { gte: since } } }),
    db.course.count({ where: { deletedAt: null } }),
    db.enrolment.count({ where: { status: 'ACTIVE' } }),
  ]);
  const stats = [
    { label: t('stats.users'), value: users },
    { label: t('stats.activeUsers'), value: active },
    { label: t('stats.courses'), value: courses },
    { label: t('stats.enrolments'), value: enrolments },
  ];
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-5">
              <p className="text-sm text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
