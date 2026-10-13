import { getCourseAccess, listGroupings, listGroups } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@hubium/ui';
import { Users } from 'lucide-react';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { GroupCard, NewGroupForm } from './group-parts';
import { GroupingCard, NewGroupingForm } from './grouping-parts';

export const generateMetadata = titled('course', 'tabs.groups');

export default async function GroupsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageGroups) forbidden();
  const t = await getTranslations('groups');
  const [groups, groupings, enrolled] = await Promise.all([
    listGroups(ctx, courseId),
    listGroupings(ctx, courseId),
    db.user.findMany({
      where: { enrolments: { some: { courseId } }, deletedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-4">
        {groups.length === 0 ? <EmptyState icon={<Users />} title={t('empty')} /> : null}
        {groups.map((g) => (
          <GroupCard
            key={g.id}
            courseId={courseId}
            group={{
              id: g.id,
              name: g.name,
              description: g.description,
              enrolmentKey: g.enrolmentKey ?? '',
            }}
            members={g.members.map((m) => ({ id: m.user.id, name: m.user.name }))}
            candidates={enrolled.filter((u) => !g.members.some((m) => m.userId === u.id))}
          />
        ))}
        <section className="mt-4 grid gap-4" aria-labelledby="groupings-title">
          <div>
            <h2 id="groupings-title" className="text-lg font-semibold">
              {t('groupings')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('groupingsHint')}</p>
          </div>
          {groupings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('groupingsEmpty')}</p>
          ) : null}
          {groupings.map((g) => (
            <GroupingCard
              key={g.id}
              courseId={courseId}
              grouping={{
                id: g.id,
                name: g.name,
                description: g.description,
                groupIds: g.groups.map((x) => x.groupId),
                used: g._count.activities,
              }}
              groups={groups.map((x) => ({ id: x.id, name: x.name }))}
            />
          ))}
        </section>
      </div>
      <div className="grid h-fit gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('new')}</CardTitle>
          </CardHeader>
          <CardContent>
            <NewGroupForm courseId={courseId} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('newGrouping')}</CardTitle>
          </CardHeader>
          <CardContent>
            <NewGroupingForm courseId={courseId} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
