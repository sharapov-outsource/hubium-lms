import { ForbiddenError, planDetail } from '@hubium/core';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TBody,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { Comments } from '@/components/competencies/comments';
import { CompetencyPicker } from '@/components/competencies/picker';
import { pickerFrameworks, Rating, StatusBadge } from '@/components/competencies/shared';
import { CommandButton } from '@/components/confirm-button';
import {
  addPlanCompetenciesAction,
  deletePlanAction,
  planStepAction,
  removePlanCompetencyAction,
  savePlanAction,
  unlinkPlanAction,
} from '@/server/actions/competencies';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('competencies', 'plansTitle');

const STEPS = [
  'requestReview',
  'cancelReview',
  'review',
  'stopReview',
  'approve',
  'unapprove',
  'complete',
  'reopen',
] as const;

export default async function PlanPage({ params }: { params: Promise<{ planId: string }> }) {
  const me = await requireUser();
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(planId)) notFound();
  const ctx = await getContext();
  const d = await planDetail(ctx, planId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tc, format, canModerate] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    getFormatter(),
    ctx.perm.can('competency:planmanage'),
  ]);
  const p = d.plan;
  const own = p.userId === me.id;
  const editContent = d.access.edit && !p.templateId;
  const frameworks = editContent ? await pickerFrameworks() : [];
  const proficient = d.competencies.filter((c) => c.proficiency).length;
  return (
    <>
      <PageHeader
        title={p.name}
        description={
          <Link href={own ? '/plans' : `/plans?user=${p.userId}`} className="hover:underline">
            ← {own ? t('plansTitle') : t('plansOf', { name: p.user.name })}
          </Link>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {STEPS.filter((s) => d.access[s]).map((s) => (
              <CommandButton
                key={s}
                size="sm"
                variant={s === 'approve' || s === 'complete' ? 'primary' : 'secondary'}
                confirm={s === 'complete' || s === 'unapprove' ? t(`confirmStep.${s}`) : undefined}
                run={planStepAction.bind(null, p.id, s)}
              >
                {t(`steps.${s}`)}
              </CommandButton>
            ))}
            {d.access.unlink ? (
              <CommandButton
                size="sm"
                variant="secondary"
                confirm={t('unlinkConfirm')}
                run={unlinkPlanAction.bind(null, p.id)}
              >
                {t('unlink')}
              </CommandButton>
            ) : null}
            {d.access.remove ? (
              <CommandButton
                size="sm"
                variant="destructive"
                confirm={`${tc('delete')}: ${p.name}?`}
                run={deletePlanAction.bind(null, p.id, p.userId)}
              >
                {tc('delete')}
              </CommandButton>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardContent className="grid gap-2 pt-6 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={p.status} />
                <span>{t('proficientOf', { n: proficient, total: d.competencies.length })}</span>
              </div>
              <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">{t('learner')}</dt>
                <dd>{p.user.name}</dd>
                {p.template ? (
                  <>
                    <dt className="text-muted-foreground">{t('template')}</dt>
                    <dd>{p.template.name}</dd>
                  </>
                ) : null}
                {p.dueDate ? (
                  <>
                    <dt className="text-muted-foreground">{t('dueDate')}</dt>
                    <dd>{format.dateTime(p.dueDate, { dateStyle: 'long' })}</dd>
                  </>
                ) : null}
                {d.reviewer ? (
                  <>
                    <dt className="text-muted-foreground">{t('reviewer')}</dt>
                    <dd>{d.reviewer}</dd>
                  </>
                ) : null}
              </dl>
              {p.description ? (
                <p className="whitespace-pre-line text-muted-foreground">{p.description}</p>
              ) : null}
              {p.status === 'COMPLETE' ? (
                <p className="text-xs text-muted-foreground">{t('completeNote')}</p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('competenciesTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              {d.competencies.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <THead>
                      <Tr>
                        <Th>{t('competency')}</Th>
                        <Th>{t('rating')}</Th>
                        <Th>{t('review')}</Th>
                        {editContent ? (
                          <Th>
                            <span className="sr-only">{tc('actions')}</span>
                          </Th>
                        ) : null}
                      </Tr>
                    </THead>
                    <TBody>
                      {d.competencies.map((c) => (
                        <Tr key={c.competency.id}>
                          <Td>
                            <Link
                              href={`/competencies/user/${p.userId}/${c.competency.id}`}
                              className="hover:underline"
                            >
                              {c.competency.shortName}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {c.competency.idNumber} · {c.competency.framework.shortName}
                            </span>
                          </Td>
                          <Td>
                            <Rating
                              items={c.scale.items}
                              grade={c.grade}
                              proficiency={c.proficiency}
                            />
                          </Td>
                          <Td>{c.status === 'IDLE' ? '—' : <StatusBadge status={c.status} />}</Td>
                          {editContent ? (
                            <Td className="text-right">
                              <CommandButton
                                size="sm"
                                variant="ghost"
                                aria-label={`${tc('delete')}: ${c.competency.shortName}`}
                                run={removePlanCompetencyAction.bind(null, p.id, c.competency.id)}
                              >
                                ×
                              </CommandButton>
                            </Td>
                          ) : null}
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('noCompetencies')}</p>
              )}
              {editContent ? (
                <CompetencyPicker
                  frameworks={frameworks}
                  exclude={d.competencies.map((c) => c.competency.id)}
                  action={addPlanCompetenciesAction}
                  hidden={{ planId: p.id }}
                  label={t('choose')}
                  submit={t('addCompetencies')}
                />
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('comments')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Comments
                comments={p.comments}
                target={{ planId: p.id }}
                path={`/plans/${p.id}`}
                me={me.id}
                canComment={d.access.comment}
                canModerate={canModerate}
              />
            </CardContent>
          </Card>
        </div>
        {editContent ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>{tc('edit')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ActionForm action={savePlanAction} success={tc('saved')} className="grid gap-3">
                <input type="hidden" name="id" value={p.id} />
                <FormField
                  name="name"
                  id="plan-name"
                  label={t('name')}
                  defaultValue={p.name}
                  required
                />
                <FormField name="description" id="plan-description" label={t('description')}>
                  <Textarea id="plan-description" name="description" defaultValue={p.description} />
                </FormField>
                <FormField
                  name="dueDate"
                  id="plan-due"
                  type="date"
                  label={t('dueDate')}
                  defaultValue={p.dueDate?.toISOString().slice(0, 10)}
                  className="w-48"
                />
                <div>
                  <SubmitButton>{tc('save')}</SubmitButton>
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
