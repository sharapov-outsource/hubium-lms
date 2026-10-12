import { getCourseAccess, getModule, parseAvailability, toActivityRef } from '@hubium/core';
import { fileUrl } from '@hubium/core/files/files';
import { PageHeader } from '@hubium/ui';
import { forbidden, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getModuleUI } from '@/modules/ui';
import { updateActivityAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { getContext } from '@/server/session';
import { ActivityForm } from '../../activity-form';

export default async function EditActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; activityId: string }>;
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [{ courseId, activityId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageActivities) forbidden();
  const a = await db.activity.findFirst({ where: { id: activityId, courseId } });
  if (!a) notFound();
  const m = getModule(a.moduleKey);
  const ui = getModuleUI(a.moduleKey);
  if (!m || !ui) notFound();
  const [t, tc] = await Promise.all([getTranslations('activity'), getTranslations('common')]);
  const [activities, groups, files] = await Promise.all([
    db.activity.findMany({
      where: { courseId, deletedAt: null, completionMode: { not: 'NONE' }, id: { not: a.id } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.group.findMany({
      where: { courseId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.file.findMany({
      where: { contextId: a.id, component: `mod.${a.moduleKey}` },
      orderBy: { name: 'asc' },
    }),
  ]);
  const byArea: Record<string, { id: string; name: string; url: string }[]> = {};
  for (const f of files) (byArea[f.area] ??= []).push({ id: f.id, name: f.name, url: fileUrl(f) });
  const ref = toActivityRef(a);
  const rules = (a.completionRules ?? {}) as { view?: boolean; module?: Record<string, unknown> };
  const Settings = ui.SettingsFields;
  const Completion = ui.CompletionRulesFields;
  const returnTo = sp.returnTo?.startsWith('/') ? sp.returnTo : `/course/${courseId}/a/${a.id}`;
  return (
    <>
      <PageHeader title={t('edit', { name: a.name })} />
      <ActivityForm
        action={updateActivityAction}
        hidden={{ id: a.id, returnTo }}
        courseId={courseId}
        values={{
          id: a.id,
          name: a.name,
          intro: a.intro,
          showIntro: a.showIntro,
          visibility: a.visibility,
          completionMode: a.completionMode,
          completionView: !!rules.view,
          completionExpectedAt: a.completionExpectedAt?.toISOString().slice(0, 10),
          groupMode: a.groupMode,
          availability: parseAvailability(a.availability) as never,
        }}
        settingsFields={
          <Settings
            settings={ref.settings as never}
            courseId={courseId}
            activityId={a.id}
            files={byArea}
          />
        }
        completionFields={Completion ? <Completion rules={rules.module ?? {}} /> : null}
        supportsView={!!m.supports.viewCompletion}
        supportsGroups={!!m.supports.groups}
        activities={activities}
        groups={groups}
        submitLabel={tc('save')}
      />
    </>
  );
}
