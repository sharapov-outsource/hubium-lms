import { courseCompetencies } from '@hubium/core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  PageHeader,
  Select,
} from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CompetencyPicker } from '@/components/competencies/picker';
import { pickerFrameworks, Rating } from '@/components/competencies/shared';
import { CommandButton } from '@/components/confirm-button';
import {
  addCourseCompetenciesAction,
  removeCourseCompetencyAction,
  setActivityCompetencyAction,
  setCourseCompetencyAction,
  setCourseCompetencySettingsAction,
} from '@/server/actions/competencies';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('competencies', 'courseTitle');

const OUTCOMES = ['NONE', 'EVIDENCE', 'RECOMMEND', 'COMPLETE'] as const;

export default async function CourseCompetenciesPage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}) {
  const { courseId } = await params;
  const ctx = await getContext();
  const [data, t, tc] = await Promise.all([
    courseCompetencies(ctx, courseId),
    getTranslations('competencies'),
    getTranslations('common'),
  ]);
  const [frameworks, activities] = data.manage
    ? await Promise.all([
        pickerFrameworks(),
        db.activity.findMany({
          where: { courseId, deletedAt: null },
          orderBy: [{ section: { rank: 'asc' } }, { rank: 'asc' }],
          select: { id: true, name: true },
        }),
      ])
    : [[], []];
  const me = ctx.perm.userId;
  return (
    <>
      <PageHeader
        title={t('courseTitle')}
        actions={
          data.viewRatings ? (
            <Button asChild variant="secondary">
              <Link href={`/course/${courseId}/competencies/report`}>{t('breakdown')}</Link>
            </Button>
          ) : null
        }
      />
      <div className={data.manage ? 'grid gap-6 lg:grid-cols-[1fr_24rem]' : ''}>
        <div className="grid min-w-0 content-start gap-3">
          {data.competencies.length === 0 ? <EmptyState title={t('noCourseCompetencies')} /> : null}
          {data.competencies.map((c) => (
            <Card key={c.id}>
              <CardContent className="grid gap-3 pt-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      {me ? (
                        <Link
                          href={`/competencies/user/${me}/${c.competencyId}`}
                          className="hover:underline"
                        >
                          {c.competency.shortName}
                        </Link>
                      ) : (
                        c.competency.shortName
                      )}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {c.competency.idNumber} · {c.competency.framework.shortName}
                    </p>
                    {c.competency.description ? (
                      <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
                        {c.competency.description}
                      </p>
                    ) : null}
                  </div>
                  {data.viewRatings ? null : (
                    <Rating
                      items={c.scale.items}
                      grade={c.mine?.grade}
                      proficiency={c.mine?.proficiency}
                    />
                  )}
                </div>
                {data.manage ? (
                  <div className="grid gap-3 border-t border-border pt-3">
                    <ActionForm
                      action={setCourseCompetencyAction}
                      success={tc('saved')}
                      className="flex flex-wrap items-end gap-2"
                    >
                      <input type="hidden" name="courseId" value={courseId} />
                      <input type="hidden" name="competencyId" value={c.competencyId} />
                      <FormField
                        name="ruleOutcome"
                        id={`co-${c.id}`}
                        label={t('onCourseCompletion')}
                        className="min-w-56 flex-1"
                      >
                        <Select id={`co-${c.id}`} name="ruleOutcome" defaultValue={c.ruleOutcome}>
                          {OUTCOMES.map((o) => (
                            <option key={o} value={o}>
                              {t(`outcomes.${o}`)}
                            </option>
                          ))}
                        </Select>
                      </FormField>
                      <SubmitButton variant="secondary">{tc('save')}</SubmitButton>
                    </ActionForm>
                    <div className="grid gap-1 text-sm">
                      <span className="font-medium">{t('activities')}</span>
                      {c.activities.length ? (
                        <ul className="grid gap-1">
                          {c.activities.map((a) => (
                            <li
                              key={a.id}
                              className="flex flex-wrap items-center justify-between gap-2"
                            >
                              <span>
                                {a.activity.name}{' '}
                                <span className="text-xs text-muted-foreground">
                                  {t(`outcomes.${a.ruleOutcome}`)}
                                </span>
                              </span>
                              <ActionForm action={setActivityCompetencyAction}>
                                <input type="hidden" name="courseId" value={courseId} />
                                <input type="hidden" name="activityId" value={a.activityId} />
                                <input type="hidden" name="competencyId" value={c.competencyId} />
                                <input type="hidden" name="ruleOutcome" value="REMOVE" />
                                <SubmitButton
                                  size="sm"
                                  variant="ghost"
                                  aria-label={`${tc('delete')}: ${a.activity.name}`}
                                >
                                  ×
                                </SubmitButton>
                              </ActionForm>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-muted-foreground">{t('noActivities')}</span>
                      )}
                    </div>
                    {activities.length ? (
                      <ActionForm
                        action={setActivityCompetencyAction}
                        success={tc('saved')}
                        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                      >
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="competencyId" value={c.competencyId} />
                        <FormField name="activityId" id={`aa-${c.id}`} label={t('activity')}>
                          <Select id={`aa-${c.id}`} name="activityId">
                            {activities.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                        <FormField
                          name="ruleOutcome"
                          id={`ao-${c.id}`}
                          label={t('onActivityCompletion')}
                        >
                          <Select id={`ao-${c.id}`} name="ruleOutcome" defaultValue="COMPLETE">
                            {OUTCOMES.map((o) => (
                              <option key={o} value={o}>
                                {t(`outcomes.${o}`)}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                        <SubmitButton variant="secondary">{t('link')}</SubmitButton>
                      </ActionForm>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={setCourseCompetencyAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="competencyId" value={c.competencyId} />
                        <input type="hidden" name="move" value="up" />
                        <SubmitButton size="sm" variant="ghost">
                          {t('moveUp')}
                        </SubmitButton>
                      </ActionForm>
                      <ActionForm action={setCourseCompetencyAction}>
                        <input type="hidden" name="courseId" value={courseId} />
                        <input type="hidden" name="competencyId" value={c.competencyId} />
                        <input type="hidden" name="move" value="down" />
                        <SubmitButton size="sm" variant="ghost">
                          {t('moveDown')}
                        </SubmitButton>
                      </ActionForm>
                      <CommandButton
                        size="sm"
                        variant="ghost"
                        confirm={`${t('removeFromCourse')}: ${c.competency.shortName}?`}
                        run={removeCourseCompetencyAction.bind(null, courseId, c.competencyId)}
                      >
                        {t('removeFromCourse')}
                      </CommandButton>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
        {data.manage ? (
          <div className="grid h-fit gap-6">
            <Card>
              <CardHeader>
                <CardTitle>{t('addCompetencies')}</CardTitle>
              </CardHeader>
              <CardContent>
                <CompetencyPicker
                  frameworks={frameworks}
                  exclude={data.competencies.map((c) => c.competencyId)}
                  action={addCourseCompetenciesAction}
                  hidden={{ courseId }}
                  label={t('choose')}
                  submit={tc('add')}
                  done={tc('saved')}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('settings')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm
                  action={setCourseCompetencySettingsAction}
                  success={tc('saved')}
                  className="grid gap-3"
                >
                  <input type="hidden" name="courseId" value={courseId} />
                  <label htmlFor="push-ratings" className="flex items-start gap-2 text-sm">
                    <Checkbox
                      id="push-ratings"
                      name="pushRatings"
                      defaultChecked={data.pushRatings}
                      className="mt-0.5"
                    />
                    {t('pushRatings')}
                  </label>
                  <div>
                    <SubmitButton variant="secondary">{tc('save')}</SubmitButton>
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
