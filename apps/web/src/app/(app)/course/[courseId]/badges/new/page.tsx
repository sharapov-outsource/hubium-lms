import { BadgeNew } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('badges', 'new');

export default async function NewCourseBadgePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  return <BadgeNew courseId={(await params).courseId} />;
}
