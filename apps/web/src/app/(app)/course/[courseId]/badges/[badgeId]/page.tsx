import { BadgeView } from '@/components/badges/badge-views';
import { pageParam } from '@/lib/url-params';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'courseTitle');

export default async function CourseBadgePage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string; badgeId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const [{ courseId, badgeId }, sp] = await Promise.all([params, searchParams]);
  return <BadgeView courseId={courseId} badgeId={badgeId} page={pageParam(sp.page)} />;
}
