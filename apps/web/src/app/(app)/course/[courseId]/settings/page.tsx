import {
  AI_FEATURES,
  categoriesWhereCan,
  enabledLanguages,
  getCourseAccess,
  resolveFeature,
} from '@hubium/core';
import { Button, Card, CardContent } from '@hubium/ui';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteCourseAction, updateCourseAction } from '@/server/actions/courses';
import { courseFieldViews } from '@/server/course-fields';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { CourseForm } from '../../course-form';
import { CourseAiCard } from './ai-card';
import { BackupCard } from './backup-card';

export const generateMetadata = titled('course', 'tabs.settings');

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

export default async function CourseSettingsPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canEdit) forbidden();
  const c = access.course;
  const cats = await categoriesWhereCan(ctx, 'course:create');
  if (!cats.some((x) => x.id === c.categoryId)) {
    const own = await ctx.db.category.findUniqueOrThrow({ where: { id: c.categoryId } });
    cats.unshift({ ...own, depth: 0, children: [], courseCount: 0 });
  }
  const t = await getTranslations('course');
  const canDelete = await ctx.perm.can('course:delete', courseId);
  const canBackup = await ctx.perm.can('backup:create', courseId);
  const canReset = await ctx.perm.can('course:reset', courseId);
  const canImport = await ctx.perm.can('restore:course', courseId);
  const restoreCats = canBackup ? await categoriesWhereCan(ctx, 'restore:course') : [];
  const dupCats = restoreCats.filter((x) => cats.some((y) => y.id === x.id));
  // AI features enabled site-wide can be switched off per course.
  const siteAi: (typeof AI_FEATURES)[number][] = [];
  for (const feature of AI_FEATURES)
    if (await resolveFeature(ctx.db, feature)) siteAi.push(feature);
  const courseAi = siteAi.length
    ? await ctx.db.aiCourseFeature.findMany({ where: { courseId } })
    : [];
  return (
    <div className="grid gap-6">
      <CourseForm
        action={updateCourseAction}
        customFields={{
          fields: await courseFieldViews(ctx, await getLocale(), courseId),
          values: (c.customFields ?? {}) as Record<string, string | boolean>,
        }}
        categories={cats.map((x) => ({ id: x.id, name: x.name, depth: x.depth }))}
        languages={await enabledLanguages(ctx.db)}
        values={{
          id: c.id,
          categoryId: c.categoryId,
          fullName: c.fullName,
          shortName: c.shortName,
          idNumber: c.idNumber,
          summary: c.summary,
          format: c.format,
          startDate: iso(c.startDate),
          endDate: iso(c.endDate),
          visible: c.visible,
          lang: c.lang,
          enableCompletion: c.enableCompletion,
          groupMode: c.groupMode,
          groupModeForced: c.groupModeForced,
          guestAccess: c.guestAccess,
          hasImage: !!c.imageFileId,
        }}
      />
      {siteAi.length ? (
        <CourseAiCard
          courseId={courseId}
          features={siteAi.map((feature) => ({
            feature,
            enabled: courseAi.find((x) => x.feature === feature)?.enabled ?? true,
          }))}
        />
      ) : null}
      {canBackup ? (
        <BackupCard
          courseId={c.id}
          fullName={c.fullName}
          shortName={c.shortName}
          categoryId={c.categoryId}
          categories={dupCats.map((x) => ({ id: x.id, name: x.name, depth: x.depth }))}
          canDuplicate={dupCats.length > 0}
        />
      ) : null}
      {canImport ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <span className="text-sm">{t('importHint')}</span>
            <Button asChild variant="outline">
              <Link href={`/course/${courseId}/import`}>{t('import')}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {canReset ? (
        <Card className="max-w-3xl">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <span className="text-sm">{t('resetHint')}</span>
            <Button asChild variant="outline">
              <Link href={`/course/${courseId}/reset`}>{t('reset')}</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {canDelete ? (
        <Card className="max-w-3xl border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <span className="text-sm">{t('deleteCourseConfirm')}</span>
            <CommandButton
              variant="destructive"
              confirm={t('deleteCourseConfirm')}
              run={deleteCourseAction.bind(null, courseId)}
            >
              {t('deleteCourse')}
            </CommandButton>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
