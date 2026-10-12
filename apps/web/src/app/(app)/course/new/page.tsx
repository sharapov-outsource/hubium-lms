import { categoriesWhereCan } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { createCourseAction } from '@/server/actions/courses';
import { getContext, requireUser } from '@/server/session';
import { CourseForm } from '../course-form';

export default async function NewCoursePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const cats = await categoriesWhereCan(await getContext(), 'course:create');
  if (!cats.length) forbidden();
  const t = await getTranslations('course');
  return (
    <>
      <PageHeader title={t('new')} />
      <CourseForm
        action={createCourseAction}
        categories={cats.map((c) => ({ id: c.id, name: c.name, depth: c.depth }))}
        values={{ categoryId: cats.find((c) => c.id === sp.category)?.id ?? cats[0]!.id }}
      />
    </>
  );
}
