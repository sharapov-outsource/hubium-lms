import {
  courseLetters,
  decimalToNumber,
  formatGrade,
  getCourseAccess,
  gradebookStructure,
  graderReport,
  userReport,
} from '@hubium/core';
import {
  Badge,
  Button,
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
import { Download } from 'lucide-react';
import Link from 'next/link';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getContext } from '@/server/session';
import {
  AggregationForm,
  GradeCell,
  ImportGradesForm,
  ItemSetupRow,
  ManualItemForm,
} from './grade-parts';

const n = decimalToNumber;

export default async function GradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canView) forbidden();
  const locale = (await getLocale()) as 'ru' | 'en';
  const [t, letters] = await Promise.all([
    getTranslations('grades'),
    courseLetters(ctx.db, courseId, locale),
  ]);
  const display = (
    v: number | null,
    item: {
      gradeMin: unknown;
      gradeMax: unknown;
      decimals: number;
      display: string;
      scale?: { items: string[] } | null;
    },
  ) =>
    formatGrade(
      v,
      {
        min: n(item.gradeMin as never)!,
        max: n(item.gradeMax as never)!,
        decimals: item.decimals,
        display: item.display as 'REAL',
        scale: item.scale?.items,
      },
      letters,
      locale,
    );

  if (!access.canViewAllGrades) {
    const userId = ctx.perm.userId!;
    const r = await userReport(ctx, courseId, userId);
    const items = r.items.filter((i) => i.kind !== 'CATEGORY');
    if (!items.some((i) => i.kind !== 'COURSE')) return <EmptyState title={t('noItems')} />;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('user')}</CardTitle>
        </CardHeader>
        <CardContent>
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
                      ) : i.activityId ? (
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
                    <Td className="tabular-nums">{display(v, i)}</Td>
                    <Td className="tabular-nums text-muted-foreground">
                      {n(i.gradeMin)}–{n(i.gradeMax)}
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

  const canEdit = await ctx.perm.can('grade:edit', courseId);
  const canManage = await ctx.perm.can('grade:manage', courseId);
  const view = sp.view === 'setup' && canManage ? 'setup' : 'grader';
  const nav = (
    <nav className="flex flex-wrap items-center gap-1" aria-label={t('title')}>
      <Button asChild size="sm" variant={view === 'grader' ? 'secondary' : 'ghost'}>
        <Link href={`/course/${courseId}/grades`}>{t('grader')}</Link>
      </Button>
      {canManage ? (
        <Button asChild size="sm" variant={view === 'setup' ? 'secondary' : 'ghost'}>
          <Link href={`/course/${courseId}/grades?view=setup`}>{t('setup')}</Link>
        </Button>
      ) : null}
      <span className="flex-1" />
      {(await ctx.perm.can('grade:export', courseId)) ? (
        <Button asChild size="sm" variant="outline">
          <a href={`/course/${courseId}/grades/export`}>
            <Download />
            {t('export')}
          </a>
        </Button>
      ) : null}
    </nav>
  );

  if (view === 'setup') {
    const { categories, items } = await gradebookStructure(ctx.db, courseId);
    const root = categories.find((c) => !c.parentId)!;
    return (
      <div className="grid gap-5">
        {nav}
        <Card>
          <CardContent className="pt-5">
            <AggregationForm
              courseId={courseId}
              id={root.id}
              aggregation={root.aggregation}
              dropLowest={root.dropLowest}
              onlyGraded={root.aggregateOnlyGraded}
            />
          </CardContent>
        </Card>
        <Table>
          <THead>
            <Tr>
              <Th>{t('item')}</Th>
              <Th>{t('gradeMax')}</Th>
              <Th>{t('weight')}</Th>
              <Th>{t('display')}</Th>
              <Th>{t('hidden')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {items
              .filter((i) => i.kind !== 'COURSE' && i.kind !== 'CATEGORY')
              .map((i) => (
                <ItemSetupRow
                  key={i.id}
                  courseId={courseId}
                  item={{
                    id: i.id,
                    name: i.name,
                    kind: i.kind,
                    gradeMax: n(i.gradeMax)!,
                    weight: n(i.weight)!,
                    display: i.display,
                    hidden: i.hidden,
                  }}
                />
              ))}
          </TBody>
        </Table>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('newItem')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ManualItemForm courseId={courseId} />
            </CardContent>
          </Card>
          {(await ctx.perm.can('grade:import', courseId)) ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('import')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ImportGradesForm courseId={courseId} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    );
  }

  const r = await graderReport(ctx, courseId);
  const items = r.items.filter((i) => i.kind !== 'CATEGORY');
  const ordered = [
    ...items.filter((i) => i.kind !== 'COURSE'),
    ...items.filter((i) => i.kind === 'COURSE'),
  ];
  return (
    <div className="grid gap-4">
      {nav}
      {r.users.length === 0 ? (
        <EmptyState title={t('noStudents')} />
      ) : (
        <>
          {canEdit ? <p className="text-xs text-muted-foreground">{t('editHint')}</p> : null}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('grader')}</caption>
              <thead className="bg-surface">
                <tr>
                  <th
                    scope="col"
                    className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium"
                  >
                    {t('student')}
                  </th>
                  {ordered.map((i) => (
                    <th
                      key={i.id}
                      scope="col"
                      className="min-w-28 px-2 py-2 text-left align-bottom text-xs font-medium"
                    >
                      <span className="line-clamp-2">
                        {i.kind === 'COURSE' ? t('total') : i.name}
                      </span>
                      <span className="font-normal text-muted-foreground">
                        {t(`kind.${i.kind}`)} · {n(i.gradeMax)}
                        {i.hidden ? ' · 👁‍🗨' : ''}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.users.map((u) => (
                  <tr key={u.id}>
                    <th
                      scope="row"
                      className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium whitespace-nowrap"
                    >
                      {u.name}
                    </th>
                    {ordered.map((i) => {
                      const g = r.cell.get(`${u.id}:${i.id}`);
                      const v = n(g?.finalGrade);
                      return (
                        <td
                          key={i.id}
                          className={
                            i.kind === 'COURSE'
                              ? 'bg-surface px-2 py-1.5 font-semibold tabular-nums'
                              : 'px-1 py-1 tabular-nums'
                          }
                        >
                          {i.kind === 'COURSE' || !canEdit || i.locked ? (
                            <span className="px-1">{display(v, i)}</span>
                          ) : (
                            <GradeCell
                              courseId={courseId}
                              itemId={i.id}
                              userId={u.id}
                              value={v}
                              shown={display(v, i)}
                              max={n(i.gradeMax)!}
                              overridden={!!g?.overridden}
                              label={`${u.name} — ${i.name}`}
                            />
                          )}
                          {g?.overridden ? (
                            <Badge variant="warning" className="ml-1 px-1 py-0">
                              ✎
                            </Badge>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
