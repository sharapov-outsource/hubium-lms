import { BadgeList } from '@/components/badges/badge-views';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('badges', 'siteTitle');

export default async function SiteBadgesPage() {
  await requireCapability('badge:managesite');
  return <BadgeList courseId={null} />;
}
