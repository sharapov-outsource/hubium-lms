import { sortTree } from '@hubium/core';
import { Badge } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import type { PickerFramework } from './picker';

/** Visible frameworks with their competencies in tree order, for the picker. */
export async function pickerFrameworks(): Promise<PickerFramework[]> {
  const frameworks = await db.competencyFramework.findMany({
    where: { visible: true },
    orderBy: { shortName: 'asc' },
    include: {
      competencies: {
        select: {
          id: true,
          shortName: true,
          idNumber: true,
          parentId: true,
          sortOrder: true,
          path: true,
        },
      },
    },
  });
  return frameworks.map((f) => ({
    id: f.id,
    shortName: f.shortName,
    competencies: sortTree(f.competencies).map((c) => ({
      id: c.id,
      shortName: c.shortName,
      idNumber: c.idNumber,
      depth: c.path.split('/').filter(Boolean).length,
    })),
  }));
}

/** A rating as the scale names it, marked proficient or not. */
export async function Rating({
  items,
  grade,
  proficiency,
}: {
  items: string[];
  grade: number | null | undefined;
  proficiency: boolean | null | undefined;
}) {
  const t = await getTranslations('competencies');
  if (grade === null || grade === undefined)
    return <span className="text-sm text-muted-foreground">{t('notRated')}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm">
      {items[grade - 1] ?? grade}
      {proficiency ? (
        <Badge variant="success">{t('proficient')}</Badge>
      ) : (
        <Badge variant="neutral">{t('notProficient')}</Badge>
      )}
    </span>
  );
}

/** A plan's or a review's status. */
export async function StatusBadge({ status }: { status: string }) {
  const t = await getTranslations('competencies');
  const variant =
    status === 'ACTIVE' || status === 'COMPLETE'
      ? 'success'
      : status === 'DRAFT' || status === 'IDLE'
        ? 'neutral'
        : 'warning';
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}
