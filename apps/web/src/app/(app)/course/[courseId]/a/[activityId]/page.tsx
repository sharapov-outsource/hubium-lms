import { buildModuleCtx, getActivityAccess, getModule, toActivityRef, touch } from '@hubium/core';
import { RichText } from '@hubium/editor/client';
import { Alert, Badge, Button } from '@hubium/ui';
import { ArrowLeft, Lock, Settings } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ModuleIcon } from '@/components/module-icon';
import { getModuleUI } from '@/modules/ui';
import { db } from '@/server/db';
import { describeConditions } from '@/server/lib/conditions';
import { activityName } from '@/server/page-title';
import { getContext } from '@/server/session';
import { CompletionToggle } from '../../outline-parts';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ courseId: string; activityId: string }>;
}) {
  const { courseId, activityId } = await params;
  return { title: (await activityName(courseId, activityId)) ?? undefined };
}

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; activityId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ courseId, activityId }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(activityId)) notFound();
  const ctx = await getContext();
  const {
    activity: a,
    course,
    access,
    canOpen,
    listed,
    moduleDisabled,
    missing,
  } = await getActivityAccess(ctx, activityId).catch(() => notFound());
  if (a.courseId !== courseId || a.deletedAt) notFound();
  // Activities hidden from the viewer are not found rather than shown by name as restricted.
  if (!canOpen && !listed && !access.canManageActivities) notFound();
  const [t, tm] = await Promise.all([getTranslations('course'), getTranslations('mod')]);
  const m = getModule(a.moduleKey);
  const ui = getModuleUI(a.moduleKey);
  if (!m || !ui) notFound();
  if (!canOpen) {
    return (
      <div className="grid max-w-2xl gap-4">
        <h2 className="text-xl font-semibold">{a.name}</h2>
        <Alert variant="warning" className="flex items-start gap-2">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {moduleDisabled
              ? t('moduleDisabled')
              : missing.length
                ? t('restricted', { conditions: await describeConditions(missing) })
                : t('notAvailable')}
          </span>
        </Alert>
        <Button asChild variant="secondary" className="w-fit">
          <Link href={`/course/${courseId}`}>
            <ArrowLeft />
            {t('tabs.course')}
          </Link>
        </Button>
      </div>
    );
  }
  const userId = ctx.perm.userId!;
  const mctx = buildModuleCtx(ctx);
  await touch(db, {
    kind: 'activity.view',
    userId,
    courseId,
    activityId: a.id,
    moduleKey: a.moduleKey,
    enrolled: access.isEnrolled,
  });
  const completion =
    a.completionMode !== 'NONE' && access.isEnrolled && !access.canManageActivities
      ? ((
          await db.activityCompletion.findUnique({
            where: { activityId_userId: { activityId: a.id, userId } },
          })
        )?.state ?? 'INCOMPLETE')
      : null;
  const View = ui.View as unknown as (p: Record<string, unknown>) => React.ReactNode;
  return (
    <article className="grid gap-5" data-module={a.moduleKey}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <ModuleIcon icon={m.icon} archetype={m.archetype} size={40} />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{tm(`${a.moduleKey}.name` as never)}</p>
            <h2 className="text-xl font-semibold">{a.name}</h2>
          </div>
          {a.visibility !== 'SHOWN' ? (
            <Badge variant="warning">{t('hiddenFromStudents')}</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {completion ? (
            <CompletionToggle
              courseId={courseId}
              activityId={a.id}
              manual={a.completionMode === 'MANUAL'}
              state={completion}
              labels={{
                mark: t('markDone'),
                done: t('done'),
                auto: t('completionAuto'),
                failed: t('completionFailed'),
              }}
            />
          ) : null}
          {access.canManageActivities ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/course/${courseId}/a/${a.id}/edit`}>
                <Settings />
                {t('editOn')}
              </Link>
            </Button>
          ) : null}
        </div>
      </header>
      {a.intro ? (
        <RichText html={a.intro} className="max-w-3xl text-sm text-muted-foreground" />
      ) : null}
      <View
        activity={toActivityRef(a)}
        course={{ id: course.id, fullName: course.fullName, shortName: course.shortName }}
        ctx={mctx}
        canManage={access.canManageActivities}
        searchParams={sp}
      />
    </article>
  );
}
