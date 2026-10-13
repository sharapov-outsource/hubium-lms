import { getCourseAccess } from '@hubium/core';
import { Card, CardContent, EmptyState } from '@hubium/ui';
import { Trash2 } from 'lucide-react';
import { forbidden } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { activityCommandAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('course', 'recycleBin');

export default async function BinPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageActivities) forbidden();
  const [t, format] = await Promise.all([getTranslations('course'), getFormatter()]);
  const items = await db.activity.findMany({
    where: { courseId, deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
  });
  return (
    <div className="grid max-w-3xl gap-3">
      <h2 className="text-lg font-semibold">{t('recycleBin')}</h2>
      {items.length === 0 ? <EmptyState icon={<Trash2 />} title={t('binEmpty')} /> : null}
      {items.map((a) => (
        <Card key={a.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div>
              <p className="font-medium">{a.name}</p>
              <p className="text-xs text-muted-foreground">
                {a.deletedAt
                  ? format.dateTime(a.deletedAt, { dateStyle: 'medium', timeStyle: 'short' })
                  : null}
              </p>
            </div>
            <div className="flex gap-2">
              <CommandButton
                size="sm"
                variant="secondary"
                run={activityCommandAction.bind(null, courseId, a.id, 'restore')}
              >
                {t('restore')}
              </CommandButton>
              <CommandButton
                size="sm"
                variant="destructive"
                confirm={t('purge')}
                run={activityCommandAction.bind(null, courseId, a.id, 'purge')}
              >
                {t('purge')}
              </CommandButton>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
