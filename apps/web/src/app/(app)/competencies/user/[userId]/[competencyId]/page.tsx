import { ForbiddenError, userCompetencyDetail } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, PageHeader, Select } from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { Comments } from '@/components/competencies/comments';
import { EvidenceList } from '@/components/competencies/evidence';
import { Rating, StatusBadge } from '@/components/competencies/shared';
import { CommandButton } from '@/components/confirm-button';
import {
  addEvidenceNoteAction,
  rateUserCompetencyAction,
  reviewAction,
} from '@/server/actions/competencies';
import { titled } from '@/server/page-title';
import { getContext, requireUser } from '@/server/session';

export const generateMetadata = titled('competencies', 'competency');

/** A person's competency: its rating and review, the evidence behind it, and comments. */
export default async function UserCompetencyPage({
  params,
}: {
  params: Promise<{ userId: string; competencyId: string }>;
}) {
  const me = await requireUser();
  const { userId, competencyId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(userId) || !/^[0-9a-f-]{36}$/.test(competencyId)) notFound();
  const ctx = await getContext();
  const d = await userCompetencyDetail(ctx, userId, competencyId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tc, manage] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    ctx.perm.can('competency:planmanage'),
  ]);
  const status = d.rating?.status ?? 'IDLE';
  const own = userId === me.id;
  return (
    <>
      <PageHeader
        title={d.competency.shortName}
        description={
          <span>
            {d.user.name} · {d.competency.framework.shortName} ·{' '}
            <span className="font-mono text-xs">{d.competency.idNumber}</span>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardContent className="grid gap-3 pt-6">
              {d.competency.description ? (
                <p className="whitespace-pre-line text-sm text-muted-foreground">
                  {d.competency.description}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Rating
                  items={d.scale.items}
                  grade={d.rating?.grade}
                  proficiency={d.rating?.proficiency}
                />
                {status === 'IDLE' ? null : <StatusBadge status={status} />}
                {d.reviewer && status === 'IN_REVIEW' ? (
                  <span className="text-sm text-muted-foreground">
                    {t('reviewer')}: {d.reviewer}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {d.can.requestReview && status === 'IDLE' ? (
                  <CommandButton
                    size="sm"
                    run={reviewAction.bind(null, userId, competencyId, 'request')}
                    success={t('reviewRequested')}
                  >
                    {t('requestReview')}
                  </CommandButton>
                ) : null}
                {d.can.requestReview && status === 'WAITING_FOR_REVIEW' ? (
                  <CommandButton
                    size="sm"
                    variant="secondary"
                    run={reviewAction.bind(null, userId, competencyId, 'cancel')}
                  >
                    {t('cancelReview')}
                  </CommandButton>
                ) : null}
                {d.can.review && status !== 'IN_REVIEW' ? (
                  <CommandButton
                    size="sm"
                    variant="secondary"
                    run={reviewAction.bind(null, userId, competencyId, 'start')}
                  >
                    {t('startReview')}
                  </CommandButton>
                ) : null}
                {d.can.review && status === 'IN_REVIEW' ? (
                  <CommandButton
                    size="sm"
                    variant="secondary"
                    run={reviewAction.bind(null, userId, competencyId, 'stop')}
                  >
                    {t('stopReview')}
                  </CommandButton>
                ) : null}
              </div>
              <EvidenceList evidence={d.evidence} items={d.scale.items} empty={tc('none')} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('comments')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Comments
                comments={d.comments}
                target={{ userId, competencyId }}
                path={`/competencies/user/${userId}/${competencyId}`}
                me={me.id}
                canComment={own || d.can.review || manage}
                canModerate={manage}
              />
            </CardContent>
          </Card>
        </div>
        <div className="grid h-fit gap-6">
          {d.can.review ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('rate')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <ActionForm
                  action={rateUserCompetencyAction}
                  success={t('ratedDone')}
                  className="grid gap-3"
                >
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="competencyId" value={competencyId} />
                  <FormField name="grade" id="uc-grade" label={t('rating')}>
                    <Select
                      id="uc-grade"
                      name="grade"
                      defaultValue={d.rating?.grade ? String(d.rating.grade) : ''}
                    >
                      <option value="">{t('notRated')}</option>
                      {d.scale.items.map((item, i) => (
                        <option key={item} value={String(i + 1)}>
                          {item}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField name="note" id="uc-note" label={t('note')} />
                  <div>
                    <SubmitButton>{t('rate')}</SubmitButton>
                  </div>
                </ActionForm>
                <ActionForm
                  action={addEvidenceNoteAction}
                  success={tc('saved')}
                  resetOnSuccess
                  className="grid gap-3 border-t border-border pt-4"
                >
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="competencyId" value={competencyId} />
                  <FormField name="note" id="ev-note" label={t('evidenceNote')} required />
                  <FormField name="url" id="ev-url" type="url" label={t('link')} />
                  <div>
                    <SubmitButton variant="secondary">{t('addEvidence')}</SubmitButton>
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>{t('inPlans')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {d.plans.length ? (
                d.plans.map((p) => (
                  <Link key={p.id} href={`/plans/${p.id}`} className="hover:underline">
                    {p.name}
                  </Link>
                ))
              ) : (
                <span className="text-muted-foreground">{t('noPlans')}</span>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('priorLearning')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {d.userEvidence.length ? (
                d.userEvidence.map((e) => (
                  <span key={e.id}>
                    {e.url ? (
                      <a
                        href={e.url}
                        className="text-accent hover:underline"
                        rel="noreferrer noopener"
                        target="_blank"
                      >
                        {e.name}
                      </a>
                    ) : (
                      e.name
                    )}
                  </span>
                ))
              ) : (
                <span className="text-muted-foreground">{tc('none')}</span>
              )}
              {own ? (
                <Link href="/evidence" className="text-accent hover:underline">
                  {t('evidencePage')}
                </Link>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
