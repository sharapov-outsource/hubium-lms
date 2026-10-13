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
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  addCohortMemberByLoginAction,
  cohortMembersAction,
  deleteCohortAction,
  saveCohortAction,
} from '@/server/actions/courses';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('cohorts', 'title');

export default async function CohortsPage() {
  await requireCapability('cohort:manage');
  const [t, tc] = await Promise.all([getTranslations('cohorts'), getTranslations('common')]);
  const cohorts = await db.cohort.findMany({
    orderBy: { name: 'asc' },
    include: { members: { include: { user: { select: { id: true, name: true } } } } },
  });
  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-4">
          {cohorts.length === 0 ? <EmptyState title={t('empty')} /> : null}
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
              <CardContent className="grid gap-3">
                <ul className="flex flex-wrap gap-2">
                  {c.members.map((m) => (
                    <li key={m.userId}>
                      <Badge className="gap-1">
                        {m.user.name}
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1"
                          aria-label={`${tc('delete')}: ${m.user.name}`}
                          run={cohortMembersAction.bind(null, c.id, [], [m.userId])}
                        >
                          ×
                        </CommandButton>
                      </Badge>
                    </li>
                  ))}
                </ul>
                <ActionForm
                  action={addCohortMemberByLoginAction}
                  resetOnSuccess
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="cohortId" value={c.id} />
                  <FormField
                    name="login"
                    label={t('addMember')}
                    id={`login-${c.id}`}
                    placeholder="email / login"
                    className="min-w-56"
                  />
                  <SubmitButton variant="secondary">{tc('add')}</SubmitButton>
                </ActionForm>
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className="h-fit">
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
      </div>
    </>
  );
}
