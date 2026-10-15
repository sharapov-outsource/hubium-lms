import { BadgeList } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'courseTitle');

export default async function CourseBadgesPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  return <BadgeList courseId={(await params).courseId} />;
}
