import { CustomFieldsAdmin } from '@/components/custom-fields/admin-page';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('profileFields', 'title');

export default async function ProfileFieldsPage() {
  await requireCapability('site:config');
  return <CustomFieldsAdmin kind="profile" />;
}
