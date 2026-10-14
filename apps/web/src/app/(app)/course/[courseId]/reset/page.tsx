import { resetOverview, roleName } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { ResetForm } from './reset-form';

export const generateMetadata = titled('courseReset', 'title');

export default async function CourseResetPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  if (!(await ctx.perm.can('course:reset', courseId).catch(() => false))) forbidden();
  const [t, tm, locale, o] = await Promise.all([
    getTranslations('courseReset'),
    getTranslations('mod'),
    getLocale(),
    resetOverview(ctx, courseId),
  ]);
  const roles = await db.role.findMany({
    where: { id: { in: o.roles.map((r) => r.roleId) } },
    orderBy: { sortOrder: 'asc' },
  });
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <ResetForm
        courseId={courseId}
        startDate={o.startDate?.toISOString().slice(0, 10) ?? ''}
        modules={o.modules.map((m) => ({
          key: m.key,
          name: tm(`${m.key}.name` as never),
          activities: m.activities,
        }))}
        roles={roles.map((r) => ({
          id: r.id,
          name: roleName(r, locale),
          people: o.roles.find((x) => x.roleId === r.id)?.people ?? 0,
          student: r.shortName === 'student',
        }))}
        counts={{
          grades: o.grades,
          completions: o.completions,
          groups: o.groups,
          events: o.events,
          announcements: o.announcements,
        }}
      />
    </div>
  );
}
