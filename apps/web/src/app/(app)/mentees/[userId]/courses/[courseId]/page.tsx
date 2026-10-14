import { canViewUserData, menteeStudies } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { cache } from 'react';
import { UserGradeTable } from '@/components/user-grade-table';
import { db } from '@/server/db';
import { getContext, requireUser } from '@/server/session';

const UUID = /^[0-9a-f-]{36}$/;

/** The learner and the course, once the caller may see this learner's grades in it. */
const load = cache(async (userId: string, courseId: string) => {
  await requireUser();
  if (!UUID.test(userId) || !UUID.test(courseId)) notFound();
  const ctx = await getContext();
  if (!(await canViewUserData(ctx, userId, 'grades', courseId))) forbidden();
  if (!(await menteeStudies(db, userId, courseId))) notFound();
  const [user, course] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    db.course.findUnique({ where: { id: courseId }, select: { fullName: true } }),
  ]);
  if (!user || !course) notFound();
  return { ctx, user, course };
});

type Params = { params: Promise<{ userId: string; courseId: string }> };

export async function generateMetadata({ params }: Params) {
  const { userId, courseId } = await params;
  return { title: (await load(userId, courseId)).course.fullName };
}

export default async function MenteeCoursePage({ params }: Params) {
  const { userId, courseId } = await params;
  const { ctx, user, course } = await load(userId, courseId);
  return (
    <>
      <Link
        href={`/mentees/${userId}`}
        className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {user.name}
      </Link>
      <PageHeader title={course.fullName} />
      <UserGradeTable ctx={ctx} courseId={courseId} userId={userId} linkActivities={false} />
    </>
  );
}
