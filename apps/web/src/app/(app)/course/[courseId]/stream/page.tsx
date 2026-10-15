import { listCourseAnnouncements } from '@hubium/core';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AnnouncementComposer } from '@/components/comms/announcement-composer';
import { AnnouncementList } from '@/components/comms/announcement-list';
import { uuidParam } from '@/lib/url-params';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext, orRefused } from '@/server/session';

export const generateMetadata = titled('course', 'tabs.stream');

export default async function CourseStreamPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { courseId } = await params;
  const before = uuidParam((await searchParams).before);
  const ctx = await getContext();
  const [t, { items, canPost, next }] = await Promise.all([
    getTranslations('announcements'),
    orRefused(listCourseAnnouncements(ctx, courseId, { before })),
  ]);
  const groups = canPost
    ? await db.group.findMany({
        where: { courseId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
    : [];
  return (
    <div className="grid max-w-3xl gap-4">
      <h2 className="sr-only">{t('title')}</h2>
      {canPost ? <AnnouncementComposer courseId={courseId} groups={groups} /> : null}
      <AnnouncementList items={items} canManage={canPost} groups={groups} emptyText={t('empty')} />
      {next ? (
        <Link
          href={`/course/${courseId}/stream?before=${next}`}
          className="text-sm text-accent hover:underline"
        >
          {t('older')}
        </Link>
      ) : null}
    </div>
  );
}
