import { BadgeView } from '@/components/badges/badge-views';
import { pageParam } from '@/lib/url-params';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'siteTitle');

export default async function SiteBadgePage({
  params,
  searchParams,
}: {
  params: Promise<{ badgeId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ badgeId }, sp] = await Promise.all([params, searchParams]);
  return <BadgeView courseId={null} badgeId={badgeId} page={pageParam(sp.page)} />;
}
