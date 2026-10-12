import { categoriesWhereCan, getCourseAccess } from '@hubium/core';
import { Card, CardContent } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteCourseAction, updateCourseAction } from '@/server/actions/courses';
import { getContext } from '@/server/session';
import { CourseForm } from '../../course-form';
import { BackupCard } from './backup-card';

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
  const restoreCats = canBackup ? await categoriesWhereCan(ctx, 'restore:course') : [];
  const dupCats = restoreCats.filter((x) => cats.some((y) => y.id === x.id));
  return (
    <div className="grid gap-6">
      <CourseForm
        action={updateCourseAction}
        categories={cats.map((x) => ({ id: x.id, name: x.name, depth: x.depth }))}
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
