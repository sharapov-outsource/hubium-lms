import { flattenTree, getCategoryTree } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { CategoryForm, CategoryRowActions } from './category-parts';

export const generateMetadata = titled('categories', 'title');

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requireCapability('category:manage');
  const sp = await searchParams;
  const t = await getTranslations('categories');
  const flat = flattenTree(await getCategoryTree(db, { includeHidden: true }));
  const editing = flat.find((c) => c.id === sp.edit);
  // a category cannot move into itself or below itself: those are left out of its parents
  const below = new Set<string>();
  if (editing) {
    const at = flat.indexOf(editing);
    for (const c of flat.slice(at + 1)) {
      if (c.depth <= editing.depth) break;
      below.add(c.id);
    }
  }
  const options = flat
    .filter((c) => c.id !== editing?.id && !below.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, depth: c.depth }));
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardContent className="pt-3">
            {flat.length === 0 ? (
              <EmptyState title={t('empty')} />
            ) : (
              <ul className="divide-y divide-border">
                {flat.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-3 py-2"
                    style={{ paddingLeft: `${c.depth * 1.25}rem` }}
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{c.name}</span>{' '}
                      {!c.visible ? <Badge variant="warning">{t('hidden')}</Badge> : null}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('courses')}: {c.courseCount}
                      </span>
                    </div>
                    <CategoryRowActions id={c.id} name={c.name} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{editing ? t('edit') : t('new')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CategoryForm
              key={editing?.id ?? 'new'}
              options={options}
              values={
                editing
                  ? {
                      id: editing.id,
                      name: editing.name,
                      parentId: editing.parentId,
                      idNumber: editing.idNumber,
                      description: editing.description,
                      visible: editing.visible,
                    }
                  : undefined
              }
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
