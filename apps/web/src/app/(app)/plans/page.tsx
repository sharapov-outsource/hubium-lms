import { ForbiddenError, userPlans } from '@hubium/core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  Textarea,
} from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { StatusBadge } from '@/components/competencies/shared';
import { savePlanAction } from '@/server/actions/competencies';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('competencies', 'plansTitle');

/** A person's learning plans (one's own by default). */
export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const me = await requireUser();
  const { user } = await searchParams;
  const userId = user && /^[0-9a-f-]{36}$/.test(user) ? user : me.id;
  const ctx = await getContext();
  const data = await userPlans(ctx, userId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tc, format, review] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    getFormatter(),
    ctx.perm.can('competency:review'),
  ]);
  const own = userId === me.id;
  return (
    <>
      <PageHeader
        title={own ? t('plansTitle') : t('plansOf', { name: data.user.name })}
        description={t('plansIntro')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href={own ? '/evidence' : `/evidence?user=${userId}`}>{t('evidencePage')}</Link>
            </Button>
            {review && own ? (
              <Button asChild variant="secondary">
                <Link href="/competencies/reviews">{t('reviews')}</Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className={data.canCreate ? 'grid gap-6 lg:grid-cols-[1fr_20rem]' : ''}>
        <div className="grid content-start gap-3">
          {data.plans.length === 0 ? <EmptyState title={t('noPlans')} /> : null}
          {data.plans.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <div className="grid gap-1">
                  <Link href={`/plans/${p.id}`} className="font-semibold hover:underline">
                    {p.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {p.dueDate
                      ? t('due', {
                          date: format.dateTime(p.dueDate, {
                            dateStyle: 'medium',
                            timeZone: 'UTC',
                          }),
                        })
                      : null}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span>{t('proficientOf', { n: p.proficient, total: p.total })}</span>
                  <StatusBadge status={p.status} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        {data.canCreate ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{t('newPlan')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={savePlanAction}
                success={tc('saved')}
                resetOnSuccess
                className="grid gap-3"
              >
                <input type="hidden" name="userId" value={userId} />
                <FormField name="name" id="plan-name" label={t('name')} required />
                <FormField name="description" id="plan-description" label={t('description')}>
                  <Textarea id="plan-description" name="description" />
                </FormField>
                <FormField
                  name="dueDate"
                  id="plan-due"
                  type="date"
                  label={t('dueDate')}
                  className="w-48"
                />
                <div>
                  <SubmitButton>{tc('create')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
