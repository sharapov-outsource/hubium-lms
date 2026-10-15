import { listAllSiteAnnouncements } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { AnnouncementComposer } from '@/components/comms/announcement-composer';
import { AnnouncementList } from '@/components/comms/announcement-list';
import { Pagination } from '@/components/pagination';
import { pageParam } from '@/lib/url-params';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('announcements', 'site');

export default async function SiteAnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { ctx } = await requireCapability('site:config');
  const sp = await searchParams;
  const [t, list] = await Promise.all([
    getTranslations('announcements'),
    listAllSiteAnnouncements(ctx, { page: pageParam(sp.page) }),
  ]);
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader title={t('site')} description={t('siteHint')} className="mb-0" />
      <AnnouncementComposer courseId={null} />
      <AnnouncementList items={list.items} canManage emptyText={t('empty')} />
      <Pagination page={list.page} pageSize={list.pageSize} total={list.total} />
    </div>
  );
}
