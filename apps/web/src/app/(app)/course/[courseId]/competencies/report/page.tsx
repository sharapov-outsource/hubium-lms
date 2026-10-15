import { courseBreakdown, ForbiddenError } from '@hubium/core';
import { EmptyState, PageHeader, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('competencies', 'breakdown');

/** Learners × the course's competencies: who is proficient in what, at a glance. */
export default async function CompetencyBreakdownPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  const report = await courseBreakdown(ctx, courseId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    throw e;
  });
  const t = await getTranslations('competencies');
  return (
    <>
      <PageHeader
        title={t('breakdown')}
        description={
          <Link href={`/course/${courseId}/competencies`} className="hover:underline">
            ← {t('courseTitle')}
          </Link>
        }
      />
      {report.users.length === 0 || report.competencies.length === 0 ? (
        <EmptyState title={t('nothingToShow')} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>{t('learner')}</Th>
                {report.competencies.map((c) => (
                  <Th key={c.id} title={c.shortName} className="max-w-40 truncate">
                    {c.idNumber}
                  </Th>
                ))}
                <Th>{t('proficientCount')}</Th>
              </Tr>
            </THead>
            <TBody>
              {report.users.map((u) => {
                const cells = report.competencies.map((c) => report.rating(u.id, c.id));
                return (
                  <Tr key={u.id}>
                    <Td>
                      <Link
                        href={`/course/${courseId}/competencies/user/${u.id}`}
                        className="hover:underline"
                      >
                        {u.name}
                      </Link>
                    </Td>
                    {report.competencies.map((c, i) => {
                      const r = cells[i];
                      return (
                        <Td
                          key={c.id}
                          className={cn(
                            'whitespace-nowrap text-sm',
                            r?.proficiency
                              ? 'text-success'
                              : r?.grade
                                ? 'text-warning'
                                : 'text-muted-foreground',
                          )}
                        >
                          {r?.grade ? (c.scale.items[r.grade - 1] ?? r.grade) : '—'}
                        </Td>
                      );
                    })}
                    <Td>
                      {cells.filter((r) => r?.proficiency).length}/{report.competencies.length}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </>
  );
}
