import 'server-only';
import {
  courseLetters,
  formatGrade,
  decimalToNumber as n,
  type RequestContext,
  userReport,
} from '@hubium/core';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';

/**
 * A learner's grades in a course as the learner sees them (hidden items left out): on the
 * course's Grades tab, and for the learner's mentors. Mentors are not in the course, so
 * activities are not linked for them.
 */
export async function UserGradeTable({
  ctx,
  courseId,
  userId,
  linkActivities = true,
}: {
  ctx: RequestContext;
  courseId: string;
  userId: string;
  linkActivities?: boolean;
}) {
  const [t, letters, locale, r] = await Promise.all([
    getTranslations('grades'),
    courseLetters(ctx.db, courseId),
    getLocale(),
    userReport(ctx, courseId, userId),
  ]);
  const items = r.items.filter((i) => i.kind !== 'CATEGORY');
  if (!items.some((i) => i.kind !== 'COURSE')) return <EmptyState title={t('noItems')} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('user')}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <THead>
            <Tr>
              <Th>{t('item')}</Th>
              <Th>{t('title')}</Th>
              <Th>{t('range')}</Th>
              <Th>{t('percent')}</Th>
              <Th>{t('feedback')}</Th>
            </Tr>
          </THead>
          <TBody>
            {items.map((i) => {
              const g = r.grades.get(i.id);
              const v = n(g?.finalGrade);
              const pct =
                v === null
                  ? null
                  : ((v - n(i.gradeMin)!) / (n(i.gradeMax)! - n(i.gradeMin)!)) * 100;
              return (
                <Tr
                  key={i.id}
                  className={i.kind === 'COURSE' ? 'bg-surface font-semibold' : undefined}
                >
                  <Td>
                    {i.kind === 'COURSE' ? (
                      t('total')
                    ) : i.activityId && linkActivities ? (
                      <Link
                        href={`/course/${courseId}/a/${i.activityId}`}
                        className="hover:underline"
                      >
                        {i.name}
                      </Link>
                    ) : (
                      i.name
                    )}
                  </Td>
                  <Td className="tabular-nums">
                    {formatGrade(
                      v,
                      {
                        min: n(i.gradeMin)!,
                        max: n(i.gradeMax)!,
                        decimals: i.decimals,
                        display: i.display,
                        scale: i.scale?.items,
                      },
                      letters,
                      locale,
                    )}
                  </Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {i.scale
                      ? `${i.scale.items[0]} … ${i.scale.items.at(-1)}`
                      : `${n(i.gradeMin)}–${n(i.gradeMax)}`}
                  </Td>
                  <Td className="tabular-nums">
                    {pct === null ? '—' : `${Math.round(pct * 10) / 10}%`}
                  </Td>
                  <Td className="max-w-xs text-sm">
                    {g?.feedback ? (
                      <span
                        className="line-clamp-2"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on save
                        dangerouslySetInnerHTML={{ __html: g.feedback }}
                      />
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}
