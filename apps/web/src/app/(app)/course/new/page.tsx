import { categoriesWhereCan, enabledLanguages } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { createCourseAction } from '@/server/actions/courses';
import { courseFieldViews } from '@/server/course-fields';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';
import { CourseForm } from '../course-form';

export const generateMetadata = titled('course', 'new');

export default async function NewCoursePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const ctx = await getContext();
  const cats = await categoriesWhereCan(ctx, 'course:create');
  if (!cats.length) forbidden();
  const t = await getTranslations('course');
  const categoryId = cats.find((c) => c.id === sp.category)?.id ?? cats[0]!.id;
  return (
    <>
      <PageHeader title={t('new')} />
      <CourseForm
        action={createCourseAction}
        categories={cats.map((c) => ({ id: c.id, name: c.name, depth: c.depth }))}
        languages={await enabledLanguages(db)}
        values={{ categoryId }}
        customFields={{
          fields: await courseFieldViews(ctx, await getLocale(), categoryId),
          values: {},
        }}
      />
    </>
  );
}
