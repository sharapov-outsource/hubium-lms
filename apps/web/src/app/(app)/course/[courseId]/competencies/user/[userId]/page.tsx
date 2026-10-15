import { ForbiddenError, learnerInCourse } from '@hubium/core';
import { Card, CardContent, PageHeader, Select } from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { EvidenceList } from '@/components/competencies/evidence';
import { Rating } from '@/components/competencies/shared';
import { rateInCourseAction } from '@/server/actions/competencies';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('competencies', 'courseTitle');

/** A learner's competencies in the course: ratings, evidence, and a teacher's rating form. */
export default async function LearnerCompetenciesPage({
  params,
}: {
  params: Promise<{ courseId: string; userId: string }>;
}) {
  const { courseId, userId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(userId)) notFound();
  const ctx = await getContext();
  const data = await learnerInCourse(ctx, courseId, userId).catch((e) => {
    if (e instanceof ForbiddenError) forbidden();
    notFound();
  });
  const [t, tc, rate] = await Promise.all([
    getTranslations('competencies'),
    getTranslations('common'),
    ctx.perm.can('competency:rate', courseId),
  ]);
  return (
    <>
      <PageHeader
        title={data.user.name}
        description={
          <Link href={`/course/${courseId}/competencies/report`} className="hover:underline">
            ← {t('breakdown')}
          </Link>
        }
      />
      <div className="grid gap-3">
        {data.competencies.map((c) => (
          <Card key={c.id}>
            <CardContent className="grid gap-3 pt-6">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">
                    <Link href={`/competencies/user/${userId}/${c.id}`} className="hover:underline">
                      {c.shortName}
                    </Link>
                  </h2>
                  <p className="text-xs text-muted-foreground">{c.idNumber}</p>
                </div>
                <div className="grid justify-items-end gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('inCourse')}:</span>
                    <Rating
                      items={c.scale.items}
                      grade={c.rating?.grade}
                      proficiency={c.rating?.proficiency}
                    />
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('overall')}:</span>
                    <Rating
                      items={c.scale.items}
                      grade={c.own?.grade}
                      proficiency={c.own?.proficiency}
                    />
                  </span>
                </div>
              </div>
              {rate ? (
                <ActionForm
                  action={rateInCourseAction}
                  success={t('ratedDone')}
                  className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
                >
                  <input type="hidden" name="courseId" value={courseId} />
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="competencyId" value={c.id} />
                  <FormField name="grade" id={`rate-${c.id}`} label={t('rating')}>
                    <Select
                      id={`rate-${c.id}`}
                      name="grade"
                      defaultValue={c.rating?.grade ? String(c.rating.grade) : ''}
                    >
                      <option value="">{t('notRated')}</option>
                      {c.scale.items.map((item, i) => (
                        <option key={item} value={String(i + 1)}>
                          {item}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField name="note" id={`note-${c.id}`} label={t('note')} />
                  <SubmitButton variant="secondary">{t('rate')}</SubmitButton>
                </ActionForm>
              ) : null}
              <EvidenceList evidence={c.evidence} items={c.scale.items} empty={tc('none')} />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
