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
import { requireCapability } from '@/server/session';
import { CategoryForm, CategoryRowActions } from './category-parts';

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
  const options = flat.map((c) => ({ id: c.id, name: c.name, depth: c.depth }));
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
                      {!c.visible ? <Badge variant="warning">{t('visible')}: ✗</Badge> : null}
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
              options={options.filter((o) => o.id !== editing?.id)}
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
