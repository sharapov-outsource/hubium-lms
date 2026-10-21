import { listConflicts } from '@hubium/core/node/conflicts';
import { PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ConflictsTable } from '@/components/node-conflicts';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('nodes', 'conflictsTitle');

/** Work done on local nodes without a connection that the cloud did not take, in this course. */
export default async function CourseNodeConflictsPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const { ctx } = await requireCapability('grade:edit', courseId);
  const [t, rows] = await Promise.all([getTranslations('nodes'), listConflicts(ctx, { courseId })]);
  return (
    <div className="grid gap-6">
      <PageHeader title={t('conflictsTitle')} description={t('courseConflictsDescription')} />
      <ConflictsTable rows={rows} />
    </div>
  );
}
