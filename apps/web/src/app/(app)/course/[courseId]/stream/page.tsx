import { listCourseAnnouncements } from '@hubium/core';
import { getTranslations } from 'next-intl/server';
import { AnnouncementComposer } from '@/components/comms/announcement-composer';
import { AnnouncementList } from '@/components/comms/announcement-list';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export default async function CourseStreamPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  const [t, { items, canPost }] = await Promise.all([
    getTranslations('announcements'),
    listCourseAnnouncements(ctx, courseId),
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
      <AnnouncementList items={items} canManage={canPost} emptyText={t('empty')} />
    </div>
  );
}
