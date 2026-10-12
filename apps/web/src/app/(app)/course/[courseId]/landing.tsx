import { getCourseAccess } from '@hubium/core';
import { RichText } from '@hubium/editor/client';
import { Alert, Card, CardContent } from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { courseGradient, courseImageUrl } from '@/components/course-card';
import { selfEnrolAction } from '@/server/actions/courses';
import { db } from '@/server/db';
import { getContext } from '@/server/session';

export async function CourseLanding({ courseId }: { courseId: string }) {
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  const course = access.course;
  const [t, format] = await Promise.all([getTranslations('catalog'), getFormatter()]);
  const [self, teachers] = await Promise.all([
    db.enrolmentMethod.findFirst({ where: { courseId, type: 'SELF', enabled: true } }),
    db.user.findMany({
      where: {
        roleAssignments: { some: { contextId: courseId, role: { shortName: 'editingteacher' } } },
        deletedAt: null,
      },
      select: { id: true, name: true },
      take: 5,
    }),
  ]);
  const open =
    self &&
    (!self.startsAt || self.startsAt <= new Date()) &&
    (!self.endsAt || self.endsAt > new Date());
  const img = courseImageUrl(course.imageFileId);
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Card className="overflow-hidden">
        <div
          className="h-40"
          style={
            img
              ? {
                  backgroundImage: `url(${img})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }
              : { background: courseGradient(course.id) }
          }
        />
        <CardContent className="grid gap-3 pt-5">
          {course.summary ? <RichText html={course.summary} /> : null}
          <dl className="grid gap-1 text-sm">
            {teachers.length ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('teachers')}:</dt>
                <dd>{teachers.map((x) => x.name).join(', ')}</dd>
              </div>
            ) : null}
            {course.startDate ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('starts')}:</dt>
                <dd>{format.dateTime(course.startDate, { dateStyle: 'long' })}</dd>
              </div>
            ) : null}
            {course.endDate ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('ends')}:</dt>
                <dd>{format.dateTime(course.endDate, { dateStyle: 'long' })}</dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="grid gap-4 pt-5">
          {open ? (
            <ActionForm action={selfEnrolAction} className="grid gap-3">
              <input type="hidden" name="courseId" value={courseId} />
              {self.key ? (
                <FormField name="key" label={t('enrolKey')} autoComplete="off" required />
              ) : null}
              <SubmitButton size="lg">{t('enrol')}</SubmitButton>
            </ActionForm>
          ) : (
            <Alert variant="warning">{t('selfDisabled')}</Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
