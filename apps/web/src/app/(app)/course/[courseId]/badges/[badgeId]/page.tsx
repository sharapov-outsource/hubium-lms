import { BadgeView } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'courseTitle');

export default async function CourseBadgePage({
  params,
}: {
  params: Promise<{ courseId: string; badgeId: string }>;
}) {
  const { courseId, badgeId } = await params;
  return <BadgeView courseId={courseId} badgeId={badgeId} />;
}
