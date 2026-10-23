import { listConflicts } from '@hubium/core/node/conflicts';
import { Button, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ConflictsTable } from '@/components/node-conflicts';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('nodes', 'conflictsTitle');

export default async function NodeConflictsPage({
  searchParams,
}: {
  searchParams: Promise<{ node?: string }>;
}) {
  const { ctx } = await requireCapability('site:config');
  const { node } = await searchParams;
  const [t, tc, rows] = await Promise.all([
    getTranslations('nodes'),
    getTranslations('common'),
    listConflicts(ctx, node && /^[0-9a-f-]{36}$/.test(node) ? { nodeId: node } : {}),
  ]);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={t('conflictsTitle')}
        description={t('conflictsDescription')}
        className="mb-0"
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/nodes">{tc('back')}</Link>
          </Button>
        }
      />
      <ConflictsTable rows={rows} />
    </div>
  );
}
