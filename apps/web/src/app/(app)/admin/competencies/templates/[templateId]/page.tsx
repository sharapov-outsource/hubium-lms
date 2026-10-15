import { templateDetail } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, PageHeader, Select, Textarea } from '@hubium/ui';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CompetencyPicker } from '@/components/competencies/picker';
import { pickerFrameworks, StatusBadge } from '@/components/competencies/shared';
import { CommandButton } from '@/components/confirm-button';
import {
  addTemplateCompetenciesAction,
  createPlansAction,
  deleteTemplateAction,
  removeTemplateCompetencyAction,
  setTemplateCohortAction,
} from '@/server/actions/competencies';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { TemplateForm } from '../template-form';

export const generateMetadata = titled('competencies', 'templates');

export default async function PlanTemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { ctx } = await requireCapability('competency:templatemanage');
  const { templateId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(templateId)) notFound();
  const tpl = await templateDetail(ctx, templateId).catch(() => null);
  if (!tpl) notFound();
  const [t, tc, frameworks, cohorts] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    pickerFrameworks(),
    db.cohort.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const linkedCohorts = tpl.cohorts.map((c) => c.cohortId);
  return (
    <>
      <PageHeader
        title={tpl.name}
        description={
          <Link href="/admin/competencies/templates" className="hover:underline">
            ← {t('templates')}
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <CommandButton
              size="sm"
              variant="secondary"
              confirm={t('deleteTemplateKeep')}
              run={deleteTemplateAction.bind(null, tpl.id, false)}
            >
              {t('deleteKeepPlans')}
            </CommandButton>
            <CommandButton
              size="sm"
              variant="destructive"
              confirm={t('deleteTemplateAll')}
              run={deleteTemplateAction.bind(null, tpl.id, true)}
            >
              {t('deleteWithPlans')}
            </CommandButton>
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('competenciesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {tpl.competencies.length ? (
                <ul className="grid gap-1 text-sm">
                  {tpl.competencies.map((c) => (
                    <li key={c.competencyId} className="flex items-center justify-between gap-2">
                      <span>
                        {c.competency.shortName}{' '}
                        <span className="text-xs text-muted-foreground">
                          {c.competency.idNumber} · {c.competency.framework.shortName}
                        </span>
                      </span>
                      <CommandButton
                        size="sm"
                        variant="ghost"
                        aria-label={`${tc('delete')}: ${c.competency.shortName}`}
                        run={removeTemplateCompetencyAction.bind(null, tpl.id, c.competencyId)}
                      >
                        ×
                      </CommandButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noCompetencies')}</p>
              )}
              <CompetencyPicker
                frameworks={frameworks}
                exclude={tpl.competencies.map((c) => c.competencyId)}
                action={addTemplateCompetenciesAction}
                hidden={{ templateId: tpl.id }}
                label={t('choose')}
                submit={t('addCompetencies')}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('plans')}</CardTitle>
            </CardHeader>
            <CardContent>
              {tpl.plans.length ? (
                <ul className="grid gap-1 text-sm">
                  {tpl.plans.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2">
                      <Link href={`/plans/${p.id}`} className="hover:underline">
                        {p.user.name}
                      </Link>
                      <StatusBadge status={p.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noPlans')}</p>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('settings')}</CardTitle>
            </CardHeader>
            <CardContent>
              <TemplateForm template={tpl} />
            </CardContent>
          </Card>
          {tpl.createPlans ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('createPlans')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm
                  action={createPlansAction}
                  success={t('plansCreated')}
                  resetOnSuccess
                  className="grid gap-3"
                >
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <FormField
                    name="logins"
                    id="plan-logins"
                    label={t('people')}
                    hint={t('peopleHint')}
                  >
                    <Textarea id="plan-logins" name="logins" className="min-h-20" />
                  </FormField>
                  <div>
                    <SubmitButton>{t('create')}</SubmitButton>
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>{t('cohorts')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-xs text-muted-foreground">{t('cohortsHint')}</p>
              {tpl.cohorts.length ? (
                <ul className="grid gap-1 text-sm">
                  {tpl.cohorts.map((c) => (
                    <li key={c.cohortId} className="flex items-center justify-between gap-2">
                      {c.cohort.name}
                      <ActionForm action={setTemplateCohortAction}>
                        <input type="hidden" name="templateId" value={tpl.id} />
                        <input type="hidden" name="cohortId" value={c.cohortId} />
                        <input type="hidden" name="linked" value="false" />
                        <SubmitButton
                          size="sm"
                          variant="ghost"
                          aria-label={`${tc('delete')}: ${c.cohort.name}`}
                        >
                          ×
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              ) : null}
              {cohorts.some((c) => !linkedCohorts.includes(c.id)) ? (
                <ActionForm
                  action={setTemplateCohortAction}
                  success={t('cohortLinked')}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <FormField
                    name="cohortId"
                    id="tpl-cohort"
                    label={t('cohort')}
                    className="min-w-40 flex-1"
                  >
                    <Select id="tpl-cohort" name="cohortId">
                      {cohorts
                        .filter((c) => !linkedCohorts.includes(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </Select>
                  </FormField>
                  <SubmitButton variant="secondary">{tc('add')}</SubmitButton>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
