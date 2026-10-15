import {
  compareRank,
  enabledModules,
  getCourseAccess,
  getCourseOutline,
  getModule,
  parseAvailability,
  recordCourseAccess,
  referencedActivities,
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
import { describeConditions, restrictionOptions } from '@/server/lib/conditions';
import { getContext } from '@/server/session';
import { CourseLanding } from './landing';
import {
  ActivityMenu,
  AddActivityButton,
  AddSectionButton,
  AddSubsectionButton,
  CompletionToggle,
  SectionMenu,
  SubsectionBlock,
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
  const modules = (await enabledModules(db)).map((m) => ({
    key: m.key,
    icon: m.icon,
    archetype: m.archetype,
    name: tm(`${m.key}.name` as never),
    description: tm(`${m.key}.description` as never),
  }));
  type Section = (typeof outline)[number];
  const sectionTitle = (s: Section) => {
    if (s.title) return s.title;
    if (s.parentId) return t('subsection');
    if (s.index === 0) return t('general');
    if (course.format === 'WEEKS' && course.startDate) {
      const start = new Date(course.startDate.getTime() + (s.index - 1) * 7 * 86_400_000);
      const end = new Date(start.getTime() + 6 * 86_400_000);
      return format.dateTimeRange(start, end, { day: 'numeric', month: 'long', timeZone: 'UTC' });
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
  // whose restrictions name each activity: deleting it is shown to set those conditions aside
  const dependents = new Map<string, string[]>();
  if (editing) {
    const note = (raw: unknown, name: string) => {
      for (const id of new Set(referencedActivities(parseAvailability(raw))))
        dependents.set(id, [...(dependents.get(id) ?? []), name]);
    };
    for (const s of outline) {
      note(s.availability, sectionTitle(s));
      for (const x of s.activities) note(x.activity.availability, x.activity.name);
    }
  }
  // what a section's access conditions can name, for its edit dialog
  const restrictions = editing ? await restrictionOptions(courseId) : undefined;
  const top = outline.filter((s) => !s.parentId);
  const subsectionsOf = (id: string) => outline.filter((x) => x.parentId === id);
  const topForMove = top.map((s) => ({ id: s.id, title: sectionTitle(s) }));
  // activities move into sections and subsections alike
  const sectionsForMove = top.flatMap((s) => [
    { id: s.id, title: sectionTitle(s) },
    ...subsectionsOf(s.id).map((c) => ({
      id: c.id,
      title: `${sectionTitle(s)} › ${sectionTitle(c)}`,
    })),
  ]);
  const isEmpty = outline.every((s) => s.activities.length === 0 && !s.summary);

  const restrictedNote = (s: Section, className: string) =>
    sectionRestricted.has(s.id) ? (
      <p className={`flex items-center gap-2 text-sm text-muted-foreground ${className}`}>
        <Lock className="size-4" aria-hidden />
        {t('restricted', { conditions: sectionRestricted.get(s.id)! })}
      </p>
    ) : null;

  const renderActivity = ({
    activity: a,
    available,
    completion,
    moduleDisabled,
  }: Section['activities'][number]) => {
    const m = getModule(a.moduleKey);
    const ui = getModuleUI(a.moduleKey);
    const ref = m ? toActivityRef(a) : null;
    const menu = editing ? (
      <ActivityMenu
        courseId={courseId}
        activity={{
          id: a.id,
          name: a.name,
          visibility: a.visibility,
          disabled: moduleDisabled,
        }}
        dependents={dependents.get(a.id) ?? []}
        sections={sectionsForMove}
      />
    ) : null;
    if (m?.archetype === 'inline' && ui?.Inline && ref && !moduleDisabled) {
      const Inline = ui.Inline as (p: { activity: unknown }) => React.ReactNode;
      return (
        <li key={a.id} id={`a-${a.id}`} className="flex items-start gap-3 px-5 py-3">
          <div className="min-w-0 flex-1">
            <Inline activity={ref} />
          </div>
          {menu}
        </li>
      );
    }
    const reason = restricted.get(a.id);
    return (
      <li key={a.id} id={`a-${a.id}`} className="flex items-center gap-3 px-5 py-3">
        <ModuleIcon icon={m?.icon ?? 'Box'} archetype={m?.archetype} />
        <div className="min-w-0 flex-1">
          {available ? (
            <Link href={`/course/${courseId}/a/${a.id}`} className="font-medium hover:underline">
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
            {moduleDisabled ? <Badge variant="warning">{t('moduleDisabledBadge')}</Badge> : null}
            {reason ? (
              <span className="flex items-center gap-1">
                <Lock className="size-3" aria-hidden />
                {t('restricted', { conditions: reason })}
              </span>
            ) : null}
          </div>
          {a.showIntro && a.intro ? <RichText html={a.intro} className="mt-1 text-sm" /> : null}
        </div>
        {completion !== null && access.isEnrolled && !access.canManageActivities && available ? (
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
        {menu}
      </li>
    );
  };

  const renderSubsection = (c: Section) => (
    <li key={c.id} id={`s-${c.id}`} className="px-5 py-3">
      <SubsectionBlock
        id={c.id}
        title={sectionTitle(c)}
        badges={!c.visible ? <Badge variant="warning">{t('hiddenFromStudents')}</Badge> : null}
        menu={
          editing ? (
            <SectionMenu
              courseId={courseId}
              section={{
                id: c.id,
                title: c.title,
                label: sectionTitle(c),
                summary: c.summary,
                visible: c.visible,
                isFirst: false,
                parentId: c.parentId,
                availability: parseAvailability(c.availability) as never,
              }}
              sections={topForMove}
              restrictions={restrictions}
            />
          ) : null
        }
      >
        {c.summary ? <RichText html={c.summary} className="px-4 pt-3 text-sm" /> : null}
        {restrictedNote(c, 'px-4 pt-3')}
        {c.activities.length ? (
          <ul className="divide-y divide-border">{c.activities.map(renderActivity)}</ul>
        ) : null}
        {editing ? (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2">
            <AddActivityButton courseId={courseId} sectionId={c.id} modules={modules} />
          </div>
        ) : null}
      </SubsectionBlock>
    </li>
  );

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
      {top.map((s) => {
        const subsections = subsectionsOf(s.id);
        const empty = s.activities.length === 0 && subsections.length === 0 && !s.summary;
        if (!editing && empty && (s.index === 0 || !s.title)) return null;
        // activities and subsections in one order
        const items = [
          ...s.activities.map((e) => ({ rank: e.activity.rank, node: renderActivity(e) })),
          ...subsections.map((c) => ({ rank: c.rank, node: renderSubsection(c) })),
        ].sort(compareRank);
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
                    label: sectionTitle(s),
                    summary: s.summary,
                    visible: s.visible,
                    isFirst: s.index === 0,
                    availability: parseAvailability(s.availability) as never,
                  }}
                  restrictions={restrictions}
                />
              ) : null}
            </div>
            {s.summary ? <RichText html={s.summary} className="px-5 pt-3 text-sm" /> : null}
            {restrictedNote(s, 'px-5 pt-3')}
            <ul className="divide-y divide-border">{items.map((x) => x.node)}</ul>
            {editing ? (
              <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3">
                <AddActivityButton courseId={courseId} sectionId={s.id} modules={modules} />
                <AddSubsectionButton courseId={courseId} parentId={s.id} />
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
