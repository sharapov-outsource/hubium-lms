import { Alert } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { selfEnrolAction } from '@/server/actions/courses';
import { db } from '@/server/db';

/** The course's self enrolment, when it is open now; null otherwise. */
export async function openSelfEnrolment(courseId: string, now = new Date()) {
  const self = await db.enrolmentMethod.findFirst({
    where: { courseId, type: 'SELF', enabled: true },
  });
  if (!self || (self.startsAt && self.startsAt > now) || (self.endsAt && self.endsAt <= now))
    return null;
  return self;
}

/** Enrolling oneself: the key when the method has one, and the button. */
export async function SelfEnrolForm({
  courseId,
  needsKey,
  inline = false,
}: {
  courseId: string;
  needsKey: boolean;
  /** In a line (a notice over the course) rather than a column. */
  inline?: boolean;
}) {
  const t = await getTranslations('catalog');
  return (
    <ActionForm
      action={selfEnrolAction}
      className={inline ? 'flex flex-wrap items-end gap-3' : 'grid gap-3'}
    >
      <input type="hidden" name="courseId" value={courseId} />
      {needsKey ? <FormField name="key" label={t('enrolKey')} autoComplete="off" required /> : null}
      <SubmitButton size={inline ? undefined : 'lg'}>{t('enrol')}</SubmitButton>
    </ActionForm>
  );
}

/**
 * Over a course a guest looks into: that they are a guest, and the self enrolment when the
 * course has one open (a guest sees the course, not the page with the enrolment form).
 */
export async function GuestNotice({ courseId }: { courseId: string }) {
  const t = await getTranslations('catalog');
  const self = await openSelfEnrolment(courseId);
  return (
    <Alert className="mb-4 grid gap-3">
      <p>{self ? t('guestCanEnrol') : t('guestNotice')}</p>
      {self ? <SelfEnrolForm courseId={courseId} needsKey={!!self.key} inline /> : null}
    </Alert>
  );
}
