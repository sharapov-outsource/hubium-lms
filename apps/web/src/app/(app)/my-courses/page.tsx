import { categoriesWhereCan, listMyCourses } from '@hubium/core';
import { Button, EmptyState, PageHeader } from '@hubium/ui';
import { BookOpen, Plus } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { CourseCard } from '@/components/course-card';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

export async function generateMetadata() {
  return { title: (await getTranslations('nav'))('myCourses') };
}

export default async function MyCoursesPage() {
  const user = await requireUser();
  const [t, td, tc] = await Promise.all([
    getTranslations('nav'),
    getTranslations('dashboard'),
    getTranslations('course'),
  ]);
  const courses = await listMyCourses(db, user.id);
  const canCreate = (await categoriesWhereCan(await getContext(), 'course:create')).length > 0;
  return (
    <>
      <PageHeader
        title={t('myCourses')}
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/course/new">
                <Plus />
                {tc('new')}
              </Link>
            </Button>
          ) : null
        }
      />
      {courses.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title={td('noCourses')}
          action={
            <Button asChild variant="secondary">
              <Link href="/catalog">{td('toCatalog')}</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {courses.map((c) => (
            <CourseCard key={c.id} course={c} />
          ))}
        </div>
      )}
    </>
  );
}
