import { getCourseAccess, listGroups } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@hubium/ui';
import { Users } from 'lucide-react';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { GroupCard, NewGroupForm } from './group-parts';

export const generateMetadata = titled('course', 'tabs.groups');

export default async function GroupsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageGroups) forbidden();
  const t = await getTranslations('groups');
  const [groups, enrolled] = await Promise.all([
    listGroups(ctx, courseId),
    db.user.findMany({
      where: { enrolments: { some: { courseId } }, deletedAt: null },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, name: true },
    }),
  ]);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="grid content-start gap-4">
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
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <NewGroupForm courseId={courseId} />
        </CardContent>
      </Card>
    </div>
  );
}
