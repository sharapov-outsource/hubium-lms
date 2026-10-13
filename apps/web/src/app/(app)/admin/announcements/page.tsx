import { listAllSiteAnnouncements } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { AnnouncementComposer } from '@/components/comms/announcement-composer';
import { AnnouncementList } from '@/components/comms/announcement-list';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('announcements', 'site');

export default async function SiteAnnouncementsPage() {
  const ctx = await getContext();
  const [t, items] = await Promise.all([
    getTranslations('announcements'),
    listAllSiteAnnouncements(ctx),
  ]);
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={t('site')} description={t('siteHint')} className="mb-0" />
      <AnnouncementComposer courseId={null} />
      <AnnouncementList items={items} canManage emptyText={t('empty')} />
    </div>
  );
}
