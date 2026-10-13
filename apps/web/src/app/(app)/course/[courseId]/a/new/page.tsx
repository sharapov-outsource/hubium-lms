import { getCourseAccess, getModule } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { forbidden, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getModuleUI } from '@/modules/ui';
import { createActivityAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { getContext } from '@/server/session';
import { ActivityForm } from '../activity-form';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>;
}) {
  const { module } = await searchParams;
  const m = module ? getModule(module) : undefined;
  if (!m) return {};
  const [t, tm] = await Promise.all([getTranslations('activity'), getTranslations('mod')]);
  return { title: t('new', { module: tm(`${m.key}.name` as never) }) };
}

export default async function NewActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ module?: string; section?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageActivities) forbidden();
  const m = sp.module ? getModule(sp.module) : undefined;
  const ui = sp.module ? getModuleUI(sp.module) : undefined;
  if (!m || !ui) notFound();
  const section = sp.section
    ? await db.courseSection.findFirst({ where: { id: sp.section, courseId } })
    : await db.courseSection.findFirst({ where: { courseId }, orderBy: { rank: 'asc' } });
  if (!section) notFound();
  const [t, tm, tc] = await Promise.all([
    getTranslations('activity'),
    getTranslations('mod'),
    getTranslations('common'),
  ]);
  const [activities, groups] = await Promise.all([
    db.activity.findMany({
      where: { courseId, deletedAt: null, completionMode: { not: 'NONE' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.group.findMany({
      where: { courseId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const Settings = ui.SettingsFields;
  const Completion = ui.CompletionRulesFields;
  return (
    <>
      <PageHeader title={t('new', { module: tm(`${m.key}.name` as never) })} />
      <ActivityForm
        action={createActivityAction}
        hidden={{ courseId, sectionId: section.id, moduleKey: m.key }}
        courseId={courseId}
        values={{ completionMode: m.supports.viewCompletion ? 'NONE' : 'NONE' }}
        settingsFields={<Settings settings={m.settings.defaults() as never} courseId={courseId} />}
        completionFields={Completion ? <Completion rules={{}} /> : null}
        supportsView={!!m.supports.viewCompletion}
        supportsGroups={!!m.supports.groups}
        activities={activities}
        groups={groups}
        submitLabel={tc('create')}
      />
    </>
  );
}
