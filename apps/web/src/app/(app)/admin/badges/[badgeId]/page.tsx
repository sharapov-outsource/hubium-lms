import { BadgeView } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'siteTitle');

export default async function SiteBadgePage({ params }: { params: Promise<{ badgeId: string }> }) {
  return <BadgeView courseId={null} badgeId={(await params).badgeId} />;
}
