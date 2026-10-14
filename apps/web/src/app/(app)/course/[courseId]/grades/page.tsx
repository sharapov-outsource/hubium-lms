import {
  builtInLetters,
  categoryFractions,
  courseLetters,
  decimalToNumber,
  displayCalculations,
  formatGrade,
  getCourseAccess,
  gradebookStructure,
  gradeHistory,
  graderReport,
  hasOwnLetters,
  listScales,
} from '@hubium/core';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/pagination';
import { UserGradeTable } from '@/components/user-grade-table';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { GradeCell, ImportGradesForm, ItemSetupRow, ManualItemForm } from './grade-parts';
import {
  CategoryForm,
  DeleteCategoryButton,
  LettersForm,
  MoveButtons,
  ScaleForm,
} from './setup-parts';

export const generateMetadata = titled('course', 'tabs.grades');

const n = decimalToNumber;
type Structure = Awaited<ReturnType<typeof gradebookStructure>>;
type Category = Structure['categories'][number];
type Item = Structure['items'][number];

/** Depth-first walk of the category tree (the root first). */
function walk(categories: Category[], visit: (c: Category, depth: number) => void) {
  const go = (c: Category, depth: number) => {
    visit(c, depth);
    for (const child of categories.filter((x) => x.parentId === c.id)) go(child, depth + 1);
  };
  const root = categories.find((c) => !c.parentId);
  if (root) go(root, 0);
}

export default async function GradesPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canView) forbidden();
  const locale = await getLocale();
  const [t, letters] = await Promise.all([
    getTranslations('grades'),
    courseLetters(ctx.db, courseId),
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

  if (!access.canViewAllGrades)
    return <UserGradeTable ctx={ctx} courseId={courseId} userId={ctx.perm.userId!} />;

  const [canEdit, canManage, canExport] = await Promise.all([
    ctx.perm.can('grade:edit', courseId),
    ctx.perm.can('grade:manage', courseId),
    ctx.perm.can('grade:export', courseId),
  ]);
  const views = ['grader', 'history', ...(canManage ? ['setup', 'scales'] : [])];
  const view = views.includes(sp.view ?? '') ? sp.view! : 'grader';
  const base = `/course/${courseId}/grades`;
  const tab = (key: string, label: string) => (
    <Button asChild size="sm" variant={view === key ? 'secondary' : 'ghost'}>
      <Link href={key === 'grader' ? base : `${base}?view=${key}`}>{label}</Link>
    </Button>
  );
  const nav = (
    <nav className="flex flex-wrap items-center gap-1" aria-label={t('title')}>
      {tab('grader', t('grader'))}
      {canManage ? tab('setup', t('setup')) : null}
      {canManage ? tab('scales', t('scalesLetters')) : null}
      {tab('history', t('history'))}
      <span className="flex-1" />
      {canExport ? (
        <>
          <Button asChild size="sm" variant="outline">
            <a href={`${base}/export`}>
              <Download />
              {t('export')}
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`${base}/export?format=xlsx`}>
              <Download />
              {t('exportXlsx')}
            </a>
          </Button>
        </>
      ) : null}
    </nav>
  );

  if (view === 'setup') {
    const [{ categories, items }, scales] = await Promise.all([
      gradebookStructure(ctx.db, courseId),
      listScales(ctx.db, courseId),
    ]);
    const root = categories.find((c) => !c.parentId)!;
    // formulas as written, and the ID numbers they can use
    const formulas = displayCalculations(items, categories);
    const ids = [
      ...items.flatMap((i) => (i.idNumber && i.kind !== 'COURSE' ? [i.idNumber] : [])),
      ...categories.flatMap((c) => (c.idNumber && c.parentId ? [c.idNumber] : [])),
    ].sort((x, y) => x.localeCompare(y));
    const options: { id: string; label: string }[] = [];
    walk(categories, (c, depth) =>
      options.push({
        id: c.id,
        label: `${'— '.repeat(depth)}${c.parentId ? c.name : t('wholeCourse')}`,
      }),
    );
    const itemsOf = (c: Category) =>
      items.filter(
        (i) =>
          i.kind !== 'COURSE' &&
          i.kind !== 'CATEGORY' &&
          (i.categoryId === c.id || (!i.categoryId && c.id === root.id)),
      );
    const block = (c: Category, depth: number, siblings: Category[]): React.ReactNode => {
      const own = itemsOf(c);
      const children = categories.filter((x) => x.parentId === c.id);
      const name = c.parentId ? c.name : t('wholeCourse');
      const index = siblings.indexOf(c);
      return (
        <section
          key={c.id}
          aria-label={name}
          className={depth ? 'grid gap-3 border-l-2 border-border pl-4' : 'grid gap-3'}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">
              {name}{' '}
              <span className="text-sm font-normal text-muted-foreground">
                · {t(`aggregations.${c.aggregation}`)}
                {c.parentId && n(c.weight) !== 1 ? ` · ${t('weight')} ${n(c.weight)}` : ''}
              </span>
            </h3>
            {c.parentId ? (
              <span className="flex flex-wrap items-center gap-1">
                <MoveButtons
                  courseId={courseId}
                  kind="category"
                  id={c.id}
                  name={name}
                  first={index === 0}
                  last={index === siblings.length - 1}
                />
                <DeleteCategoryButton courseId={courseId} id={c.id} name={name} />
              </span>
            ) : null}
          </div>
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('editCategory')}</summary>
            <div className="mt-3">
              <CategoryForm
                courseId={courseId}
                parents={options}
                category={{
                  id: c.id,
                  parentId: c.parentId,
                  name: c.name,
                  aggregation: c.aggregation,
                  dropLowest: c.dropLowest,
                  keepHighest: c.keepHighest,
                  onlyGraded: c.aggregateOnlyGraded,
                  weight: n(c.weight)!,
                  idNumber: c.idNumber,
                }}
              />
            </div>
          </details>
          {own.length ? (
            <Table>
              <THead>
                <Tr>
                  <Th>{t('item')}</Th>
                  <Th>{t('category')}</Th>
                  <Th>{t('gradeMax')}</Th>
                  <Th>{t('weight')}</Th>
                  <Th>{t('display')}</Th>
                  <Th>{t('hidden')}</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {own.map((i, k) => (
                  <ItemSetupRow
                    key={i.id}
                    courseId={courseId}
                    categories={options}
                    first={k === 0}
                    last={k === own.length - 1}
                    ids={ids}
                    item={{
                      id: i.id,
                      name: i.name,
                      kind: i.kind,
                      gradeMax: n(i.gradeMax)!,
                      weight: n(i.weight)!,
                      display: i.display,
                      hidden: i.hidden,
                      categoryId: i.categoryId ?? root.id,
                      scale: i.scale?.name ?? null,
                      idNumber: i.idNumber,
                      formula: formulas.get(i.id) ?? null,
                      needsUpdate: i.needsUpdate,
                      canCalculate: i.kind === 'MANUAL' && i.gradeType === 'VALUE',
                    }}
                  />
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t('emptyCategory')}</p>
          )}
          {children.map((child) => block(child, depth + 1, children))}
        </section>
      );
    };
    return (
      <div className="grid gap-5">
        {nav}
        <Card>
          <CardHeader>
            <CardTitle>{t('structure')}</CardTitle>
            <CardDescription>{t('structureHint')}</CardDescription>
          </CardHeader>
          <CardContent>{block(root, 0, [root])}</CardContent>
        </Card>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('newCategory')}</CardTitle>
            </CardHeader>
            <CardContent>
              <CategoryForm courseId={courseId} parents={options} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('newItem')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ManualItemForm
                courseId={courseId}
                categories={options}
                scales={scales.map((s) => ({ id: s.id, name: s.name }))}
              />
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

  if (view === 'scales') {
    const [scales, own, siteOwn] = await Promise.all([
      listScales(ctx.db, courseId),
      hasOwnLetters(ctx.db, courseId),
      hasOwnLetters(ctx.db, SYSTEM_CONTEXT_ID),
    ]);
    const source = own ? 'course' : siteOwn ? 'site' : 'builtin';
    const builtIn = source === 'builtin' ? await builtInLetters(ctx.db) : null;
    return (
      <div className="grid gap-5">
        {nav}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('courseScales')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6">
              {scales
                .filter((s) => s.courseId)
                .map((s) => (
                  <ScaleForm
                    key={s.id}
                    courseId={courseId}
                    scale={{ id: s.id, name: s.name, items: s.items, used: s._count.gradeItems }}
                  />
                ))}
              <div className="grid gap-2 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">{t('newScale')}</h3>
                <ScaleForm courseId={courseId} />
              </div>
            </CardContent>
          </Card>
          <div className="grid content-start gap-5">
            <Card>
              <CardHeader>
                <CardTitle>{t('letters')}</CardTitle>
                <CardDescription>{t(`lettersFrom.${source}`)}</CardDescription>
              </CardHeader>
              <CardContent>
                <LettersForm courseId={courseId} letters={builtIn ?? letters} own={own} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('siteScales')}</CardTitle>
              </CardHeader>
              <CardContent>
                {scales.some((s) => !s.courseId) ? (
                  <ul className="grid gap-2 text-sm">
                    {scales
                      .filter((s) => !s.courseId)
                      .map((s) => (
                        <li key={s.id}>
                          <span className="font-medium">{s.name}</span>
                          <span className="text-muted-foreground">: {s.items.join(' · ')}</span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('noScales')}</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'history') {
    const [h, structure, report, format] = await Promise.all([
      gradeHistory(ctx, courseId, {
        userId: sp.user || undefined,
        itemId: sp.item || undefined,
        from: sp.from || undefined,
        to: sp.to ? new Date(new Date(sp.to).getTime() + 86_400_000) : undefined,
        page: sp.page,
      }),
      gradebookStructure(ctx.db, courseId),
      graderReport(ctx, courseId),
      getFormatter(),
    ]);
    const shown = (v: number | null, item: (typeof h.rows)[number]['item']) =>
      v === null ? '—' : display(v, item);
    return (
      <div className="grid gap-5">
        {nav}
        <form className="flex flex-wrap items-end gap-3" aria-label={t('history')}>
          <input type="hidden" name="view" value="history" />
          <label className="grid gap-1 text-sm">
            {t('student')}
            <select
              name="user"
              defaultValue={sp.user ?? ''}
              className="h-9 rounded-md border border-input bg-background px-2"
            >
              <option value="">{t('all')}</option>
              {report.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t('item')}
            <select
              name="item"
              defaultValue={sp.item ?? ''}
              className="h-9 max-w-64 rounded-md border border-input bg-background px-2"
            >
              <option value="">{t('all')}</option>
              {structure.items
                .filter((i) => i.kind !== 'CATEGORY')
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.kind === 'COURSE' ? t('total') : i.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t('from')}
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? ''}
              className="h-9 rounded-md border border-input bg-background px-2"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t('to')}
            <input
              type="date"
              name="to"
              defaultValue={sp.to ?? ''}
              className="h-9 rounded-md border border-input bg-background px-2"
            />
          </label>
          <Button type="submit" variant="secondary">
            {t('apply')}
          </Button>
        </form>
        {h.rows.length ? (
          <Table>
            <THead>
              <Tr>
                <Th>{t('when')}</Th>
                <Th>{t('student')}</Th>
                <Th>{t('item')}</Th>
                <Th>{t('was')}</Th>
                <Th>{t('became')}</Th>
                <Th>{t('source')}</Th>
                <Th>{t('by')}</Th>
              </Tr>
            </THead>
            <TBody>
              {h.rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap text-sm">
                    {format.dateTime(r.changedAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </Td>
                  <Td>{r.user.name}</Td>
                  <Td>{r.item.kind === 'COURSE' ? t('total') : r.item.name}</Td>
                  <Td className="tabular-nums text-muted-foreground">
                    {shown(r.previousGrade, r.item)}
                  </Td>
                  <Td className="tabular-nums font-medium">
                    {shown(r.finalGrade, r.item)}
                    {r.overridden ? (
                      <Badge variant="warning" className="ml-1 px-1 py-0">
                        ✎
                      </Badge>
                    ) : null}
                  </Td>
                  <Td className="text-sm">
                    {t.has(`sources.${r.source}`)
                      ? t(`sources.${r.source}` as 'sources.module')
                      : r.source}
                  </Td>
                  <Td className="text-sm">{r.changedBy?.name ?? '—'}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState title={t('historyEmpty')} />
        )}
        <Pagination
          page={h.page}
          pageSize={h.pageSize}
          total={h.total}
          params={{ view: 'history', user: sp.user, item: sp.item, from: sp.from, to: sp.to }}
        />
      </div>
    );
  }

  const r = await graderReport(ctx, courseId);
  // columns in tree order: a category's items, its subcategories, then its total
  const root = r.categories.find((c) => !c.parentId);
  type Column = { kind: 'item'; item: Item } | { kind: 'category'; category: Category };
  const columns: Column[] = [];
  const counted = r.items.filter((i) => i.kind === 'MODULE' || i.kind === 'MANUAL');
  const visit = (c: Category) => {
    for (const i of counted.filter(
      (i) => i.categoryId === c.id || (!i.categoryId && c.id === root?.id),
    ))
      columns.push({ kind: 'item', item: i });
    for (const child of r.categories.filter((x) => x.parentId === c.id)) visit(child);
    if (c.parentId) columns.push({ kind: 'category', category: c });
  };
  if (root) visit(root);
  const total = r.items.find((i) => i.kind === 'COURSE');
  if (total) columns.push({ kind: 'item', item: total });
  const hasCategories = r.categories.some((c) => c.parentId);
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (
    <div className="grid gap-4">
      {nav}
      {r.users.length === 0 ? (
        <EmptyState title={t('noStudents')} />
      ) : (
        <>
          {canEdit ? <p className="text-xs text-muted-foreground">{t('editHint')}</p> : null}
          <div className="scrollbar-hairline overflow-x-auto rounded-lg border border-border">
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
                  {columns.map((col) =>
                    col.kind === 'category' ? (
                      <th
                        key={col.category.id}
                        scope="col"
                        className="min-w-24 bg-muted/40 px-2 py-2 text-left align-bottom text-xs font-semibold"
                      >
                        <span className="line-clamp-2">
                          {t('categoryTotal', { name: col.category.name })}
                        </span>
                        <span className="font-normal text-muted-foreground">%</span>
                      </th>
                    ) : (
                      <th
                        key={col.item.id}
                        scope="col"
                        className="min-w-28 px-2 py-2 text-left align-bottom text-xs font-medium"
                      >
                        <span className="line-clamp-2">
                          {col.item.kind === 'COURSE' ? t('total') : col.item.name}
                        </span>
                        <span className="font-normal text-muted-foreground">
                          {t(`kind.${col.item.kind}`)} ·{' '}
                          {col.item.scale ? col.item.scale.name : n(col.item.gradeMax)}
                          {col.item.hidden ? ' · 👁‍🗨' : ''}
                        </span>
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.users.map((u) => {
                  const fractions = hasCategories
                    ? categoryFractions(
                        r.categories,
                        counted.filter((i) => i.gradeType === 'VALUE' || i.gradeType === 'SCALE'),
                        counted.flatMap((i) => {
                          const g = r.cell.get(`${u.id}:${i.id}`);
                          return g ? [g] : [];
                        }),
                      )
                    : null;
                  return (
                    <tr key={u.id}>
                      <th
                        scope="row"
                        className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium whitespace-nowrap"
                      >
                        {u.name}
                      </th>
                      {columns.map((col) => {
                        if (col.kind === 'category') {
                          const f = fractions?.get(col.category.id);
                          return (
                            <td
                              key={col.category.id}
                              className="bg-muted/40 px-2 py-1.5 font-medium tabular-nums"
                            >
                              {f === null || f === undefined ? '—' : `${nf.format(f * 100)}%`}
                            </td>
                          );
                        }
                        const i = col.item;
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
                                scale={i.scale?.items}
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
