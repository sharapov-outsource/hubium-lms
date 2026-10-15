import { Card, CardContent, PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { FrameworkForm } from '@/components/competencies/forms';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('competencies', 'newFramework');

export default async function NewFrameworkPage() {
  await requireCapability('competency:manage');
  const [t, scales] = await Promise.all([
    getTranslations('competencies'),
    db.scale.findMany({ where: { courseId: null }, orderBy: { name: 'asc' } }),
  ]);
  return (
    <>
      <PageHeader title={t('newFramework')} />
      <Card className="max-w-3xl">
        <CardContent className="pt-6">
          <FrameworkForm scales={scales.map((s) => ({ id: s.id, name: s.name, items: s.items }))} />
        </CardContent>
      </Card>
    </>
  );
}
