import { BadgeNew } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'new');

export default function NewSiteBadgePage() {
  return <BadgeNew courseId={null} />;
}
