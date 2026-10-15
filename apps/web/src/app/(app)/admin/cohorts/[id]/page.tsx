import { Badge, Button, Card, CardContent, EmptyState, Input, PageHeader } from '@hubium/ui';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import { Pagination } from '@/components/pagination';
import { pageParam, textParam, uuidParam } from '@/lib/url-params';
import { addCohortMemberByLoginAction, cohortMembersAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { viewerCan } from '@/server/page-title';
import { requireCapability } from '@/server/session';

const PAGE_SIZE = 50;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const id = uuidParam((await params).id);
  if (!id || !(await viewerCan('cohort:manage'))) return {};
  const c = await db.cohort.findUnique({ where: { id }, select: { name: true } });
  return c ? { title: c.name } : {};
}

/** The members of a cohort, a page at a time, with a search by name or email. */
export default async function CohortMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireCapability('cohort:manage');
  const [{ id: raw }, sp] = await Promise.all([params, searchParams]);
  const id = uuidParam(raw);
  if (!id) notFound();
  const cohort = await db.cohort.findUnique({ where: { id } });
  if (!cohort) notFound();
  const [t, tc] = await Promise.all([getTranslations('cohorts'), getTranslations('common')]);
  const q = textParam(sp.q);
  const page = pageParam(sp.page);
  const where = {
    cohortId: id,
    ...(q
      ? {
          user: {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          },
        }
      : {}),
  };
  const [all, total, members] = await Promise.all([
    db.cohortMember.count({ where: { cohortId: id } }),
    db.cohortMember.count({ where }),
    db.cohortMember.findMany({
      where,
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { userId: 'asc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);
  return (
    <>
      <PageHeader
        title={cohort.name}
        description={t('membersN', { count: all })}
        actions={
          <Button asChild variant="ghost">
            <Link href="/admin/cohorts">
              <ArrowLeft />
              {t('title')}
            </Link>
          </Button>
        }
      />
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardContent className="pt-5">
            <ActionForm
              action={addCohortMemberByLoginAction}
              resetOnSuccess
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="cohortId" value={cohort.id} />
              <FormField
                name="login"
                label={t('addMember')}
                placeholder={tc('emailOrLogin')}
                className="min-w-56"
              />
              <SubmitButton variant="secondary">{tc('add')}</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
        <search className="block">
          <form className="flex max-w-xl gap-2">
            <label htmlFor="q" className="sr-only">
              {t('searchMember')}
            </label>
            <Input
              id="q"
              name="q"
              defaultValue={q}
              placeholder={t('searchMember')}
              className="min-w-48 flex-1"
            />
            <Button type="submit" variant="secondary">
              {tc('search')}
            </Button>
          </form>
        </search>
        {total === 0 ? (
          <EmptyState title={q ? tc('nothingFound') : t('noMembers')} />
        ) : (
          <ul className="flex flex-wrap gap-2">
            {members.map((m) => (
              <li key={m.userId}>
                <Badge className="gap-1">
                  {m.user.name}
                  <CommandButton
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1"
                    aria-label={`${tc('delete')}: ${m.user.name}`}
                    run={cohortMembersAction.bind(null, cohort.id, [], [m.userId])}
                  >
                    ×
                  </CommandButton>
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} params={{ q }} />
      </div>
    </>
  );
}
