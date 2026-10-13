import { categoriesWhereCan } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';
import { CourseImporter } from './importer';

export const generateMetadata = titled('backup', 'importTitle');

export default async function ImportCoursePage() {
  await requireUser();
  const ctx = await getContext();
  const [create, restore, moodle] = await Promise.all([
    categoriesWhereCan(ctx, 'course:create'),
    categoriesWhereCan(ctx, 'restore:course'),
    categoriesWhereCan(ctx, 'import:moodle'),
  ]);
  const cats = create
    .map((c) => ({
      id: c.id,
      name: c.name,
      depth: c.depth,
      hubium: restore.some((x) => x.id === c.id),
      mbz: moodle.some((x) => x.id === c.id),
    }))
    .filter((c) => c.hubium || c.mbz);
  if (!cats.length) forbidden();
  const t = await getTranslations('backup');
  return (
    <>
      <PageHeader title={t('importTitle')} description={t('importHint')} />
      <CourseImporter categories={cats} />
    </>
  );
}
