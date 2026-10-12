import {
  getCourseAccess,
  getCourseOutline,
  getModule,
  listModules,
  recordCourseAccess,
  toActivityRef,
} from '@hubium/core';
import { RichText } from '@hubium/editor/client';
import { Badge, Button, Card, EmptyState, Progress } from '@hubium/ui';
import { BookOpen, Lock, Pencil } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ModuleIcon } from '@/components/module-icon';
import { getModuleUI } from '@/modules/ui';
import { db } from '@/server/db';
import { describeConditions } from '@/server/lib/conditions';
import { getContext } from '@/server/session';
import { CourseLanding } from './landing';
import {
  ActivityMenu,
  AddActivityButton,
  AddSectionButton,
  CompletionToggle,
  SectionMenu,
} from './outline-parts';

export default async function CoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canView) return <CourseLanding courseId={courseId} />;
  const userId = ctx.perm.userId!;
  await recordCourseAccess(db, userId, courseId);
  const [t, _ta, tm, format] = await Promise.all([
    getTranslations('course'),
    getTranslations('activity'),
    getTranslations('mod'),
    getFormatter(),
  ]);
  const outline = await getCourseOutline(ctx, courseId);
  const editing = access.canManageActivities && sp.edit === '1';
  const course = access.course;
  const progress =
    access.isEnrolled && course.enableCompletion
      ? await db.courseCompletion.findUnique({ where: { courseId_userId: { courseId, userId } } })
      : null;
  const tracked = outline.some((s) => s.activities.some((a) => a.completion !== null));
  const modules = listModules().map((m) => ({
    key: m.key,
    icon: m.icon,
    archetype: m.archetype,
    name: tm(`${m.key}.name` as never),
    description: tm(`${m.key}.description` as never),
  }));
  const sectionTitle = (s: (typeof outline)[number]) => {
    if (s.title) return s.title;
    if (s.index === 0) return t('general');
    if (course.format === 'WEEKS' && course.startDate) {
      const start = new Date(course.startDate.getTime() + (s.index - 1) * 7 * 86_400_000);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      return format.dateTimeRange(start, end, { day: 'numeric', month: 'long' });
    }
    return course.format === 'WEEKS' ? t('week', { n: s.index }) : t('section', { n: s.index });
  };
  const restricted = new Map<string, string>();
  for (const s of outline) {
    for (const a of s.activities) {
      if (a.availabilityMissing.length)
        restricted.set(a.activity.id, await describeConditions(a.availabilityMissing));
    }
  }
  const sectionRestricted = new Map<string, string>();
  for (const s of outline) {
    if (!s.available && s.availabilityMissing.length)
      sectionRestricted.set(s.id, await describeConditions(s.availabilityMissing));
  }
  const sectionsForMove = outline.map((s) => ({ id: s.id, title: sectionTitle(s) }));
  const isEmpty = outline.every((s) => s.activities.length === 0 && !s.summary);

  return (
    <div className="grid gap-5">
      {(progress && tracked) || access.canManageActivities ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {progress && tracked ? (
            <div className="flex min-w-60 items-center gap-3">
              <Progress
                value={progress.progressPercent}
                label={t('progress', { percent: progress.progressPercent })}
                className="w-48"
              />
              <span className="text-sm text-muted-foreground">
                {t('progress', { percent: progress.progressPercent })}
              </span>
            </div>
          ) : (
            <span />
          )}
          {access.canManageActivities ? (
            <Button asChild variant={editing ? 'primary' : 'secondary'} size="sm">
              <Link href={editing ? `/course/${courseId}` : `/course/${courseId}?edit=1`}>
                <Pencil />
                {editing ? t('editOff') : t('editOn')}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {isEmpty && !editing ? (
        <EmptyState
          icon={<BookOpen />}
          title={t('empty')}
          description={access.canManageActivities ? t('emptyEdit') : undefined}
        />
      ) : null}
      {outline.map((s) => {
        if (!editing && s.index === 0 && s.activities.length === 0 && !s.summary) return null;
        if (!editing && s.activities.length === 0 && !s.summary && !s.title) return null;
        return (
          <Card
            key={s.id}
            id={`s-${s.id}`}
            className={!s.visible ? 'border-dashed opacity-80' : undefined}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{sectionTitle(s)}</h2>
                {!s.visible ? <Badge variant="warning">{t('hiddenFromStudents')}</Badge> : null}
              </div>
              {editing ? (
                <SectionMenu
                  courseId={courseId}
                  section={{
                    id: s.id,
                    title: s.title,
                    summary: s.summary,
                    visible: s.visible,
                    isFirst: s.index === 0,
                  }}
                />
              ) : null}
            </div>
            {s.summary ? <RichText html={s.summary} className="px-5 pt-3 text-sm" /> : null}
            {sectionRestricted.has(s.id) ? (
              <p className="flex items-center gap-2 px-5 pt-3 text-sm text-muted-foreground">
                <Lock className="size-4" aria-hidden />
                {t('restricted', { conditions: sectionRestricted.get(s.id)! })}
              </p>
            ) : null}
            <ul className="divide-y divide-border">
              {s.activities.map(({ activity: a, available, completion }) => {
                const m = getModule(a.moduleKey);
                const ui = getModuleUI(a.moduleKey);
                const ref = m ? toActivityRef(a) : null;
                if (m?.archetype === 'inline' && ui?.Inline && ref) {
                  const Inline = ui.Inline as (p: { activity: unknown }) => React.ReactNode;
                  return (
                    <li key={a.id} id={`a-${a.id}`} className="flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <Inline activity={ref} />
                      </div>
                      {editing ? (
                        <ActivityMenu
                          courseId={courseId}
                          activity={{ id: a.id, name: a.name, visibility: a.visibility }}
                          sections={sectionsForMove}
                        />
                      ) : null}
                    </li>
                  );
                }
                const reason = restricted.get(a.id);
                return (
                  <li key={a.id} id={`a-${a.id}`} className="flex items-center gap-3 px-5 py-3">
                    <ModuleIcon icon={m?.icon ?? 'Box'} archetype={m?.archetype} />
                    <div className="min-w-0 flex-1">
                      {available ? (
                        <Link
                          href={`/course/${courseId}/a/${a.id}`}
                          className="font-medium hover:underline"
                        >
                          {a.name}
                        </Link>
                      ) : (
                        <span className="font-medium text-muted-foreground">{a.name}</span>
                      )}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{tm(`${a.moduleKey}.name` as never)}</span>
                        {a.visibility === 'HIDDEN' ? (
                          <Badge variant="warning">{t('hiddenFromStudents')}</Badge>
                        ) : null}
                        {a.visibility === 'STEALTH' ? <Badge>{t('stealthBadge')}</Badge> : null}
                        {reason ? (
                          <span className="flex items-center gap-1">
                            <Lock className="size-3" aria-hidden />
                            {t('restricted', { conditions: reason })}
                          </span>
                        ) : null}
                      </div>
                      {a.showIntro && a.intro ? (
                        <RichText html={a.intro} className="mt-1 text-sm" />
                      ) : null}
                    </div>
                    {completion !== null &&
                    access.isEnrolled &&
                    !access.canManageActivities &&
                    available ? (
                      <CompletionToggle
                        courseId={courseId}
                        activityId={a.id}
                        manual={a.completionMode === 'MANUAL'}
                        state={completion}
                        labels={{ mark: t('markDone'), done: t('done'), auto: t('completionAuto') }}
                      />
                    ) : null}
                    {editing ? (
                      <ActivityMenu
                        courseId={courseId}
                        activity={{ id: a.id, name: a.name, visibility: a.visibility }}
                        sections={sectionsForMove}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {editing ? (
              <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
                <AddActivityButton courseId={courseId} sectionId={s.id} modules={modules} />
              </div>
            ) : null}
          </Card>
        );
      })}
      {editing ? (
        <div className="flex flex-wrap gap-2">
          <AddSectionButton courseId={courseId} />
          <Button asChild variant="ghost" size="sm">
            <Link href={`/course/${courseId}/bin`}>{t('recycleBin')}</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
