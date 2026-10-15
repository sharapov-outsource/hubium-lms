import { CustomFieldsAdmin } from '@/components/custom-fields/admin-page';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('courseFields', 'title');

export default async function CourseFieldsPage() {
  await requireCapability('site:config');
  return <CustomFieldsAdmin kind="course" />;
}
