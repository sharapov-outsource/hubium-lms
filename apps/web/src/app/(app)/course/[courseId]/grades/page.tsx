import { EmptyState } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';

// The gradebook arrives with phase 3.
export default async function GradesPage() {
  const t = await getTranslations('course');
  return <EmptyState title={t('tabs.grades')} />;
}
