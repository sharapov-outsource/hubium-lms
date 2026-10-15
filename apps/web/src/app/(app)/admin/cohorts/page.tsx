import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  PageHeader,
} from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { CsvImport } from '@/components/csv-import';
import { Pagination } from '@/components/pagination';
import { pageParam, textParam } from '@/lib/url-params';
import {
  deleteCohortAction,
  importCohortsAction,
  saveCohortAction,
} from '@/server/actions/cohorts';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('cohorts', 'title');

const PAGE_SIZE = 25;

export default async function CohortsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireCapability('cohort:manage');
  const sp = await searchParams;
  const [t, tc] = await Promise.all([getTranslations('cohorts'), getTranslations('common')]);
  const q = textParam(sp.q);
  const page = pageParam(sp.page);
  // counts, not the members: a cohort can hold thousands of people (see its own page)
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { idNumber: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [total, cohorts] = await Promise.all([
    db.cohort.count({ where }),
    db.cohort.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { _count: { select: { members: true } } },
    }),
  ]);
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-4">
          <search className="block">
            <form className="flex max-w-xl gap-2">
              <label htmlFor="q" className="sr-only">
                {t('search')}
              </label>
              <Input
                id="q"
                name="q"
                defaultValue={q}
                placeholder={t('search')}
                className="min-w-48 flex-1"
              />
              <Button type="submit" variant="secondary">
                {tc('search')}
              </Button>
            </form>
          </search>
          {total === 0 ? <EmptyState title={q ? tc('nothingFound') : t('empty')} /> : null}
          {cohorts.map((c) => (
            <Card key={c.id}>
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle>{c.name}</CardTitle>
                  {c.idNumber ? (
                    <p className="font-mono text-xs text-muted-foreground">{c.idNumber}</p>
                  ) : null}
                </div>
                <CommandButton
                  size="sm"
                  variant="ghost"
                  confirm={`${tc('delete')}: ${c.name}?`}
                  run={deleteCohortAction.bind(null, c.id)}
                >
                  {tc('delete')}
                </CommandButton>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('membersN', { count: c._count.members })}
                </span>
                <Button asChild size="sm" variant="secondary">
                  <Link href={`/admin/cohorts/${c.id}`}>{t('openMembers')}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} params={{ q }} />
        </div>
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('new')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={saveCohortAction}
                resetOnSuccess
                success={tc('saved')}
                className="grid gap-3"
              >
                <FormField name="name" label={t('name')} required />
                <FormField name="idNumber" label={t('idNumber')} />
                <SubmitButton>{tc('create')}</SubmitButton>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('importTitle')}</CardTitle>
            </CardHeader>
            <CardContent>
              <CsvImport
                run={importCohortsAction}
                sample={'name,idnumber,description,user\nФизики 2026,phys26,Первый курс,ivanov'}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
