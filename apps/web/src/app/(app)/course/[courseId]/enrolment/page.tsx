import { getCourseAccess, roleName } from '@hubium/core';
import { DateInput } from '@hubium/module-sdk/form';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Select,
  Textarea,
} from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  addCohortSyncAction,
  removeMethodAction,
  saveSelfEnrolmentAction,
} from '@/server/actions/enrolment';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';

export const generateMetadata = titled('course', 'tabs.enrolment');

const d = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : undefined);

export default async function EnrolmentPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const ctx = await getContext();
  const access = await getCourseAccess(ctx, courseId);
  if (!access.canManageEnrolments) forbidden();
  const [t, tc, tp, locale] = await Promise.all([
    getTranslations('enrolment'),
    getTranslations('common'),
    getTranslations('participants'),
    getLocale(),
  ]);
  const [methods, cohorts, roles] = await Promise.all([
    db.enrolmentMethod.findMany({
      where: { courseId },
      orderBy: { sortOrder: 'asc' },
      include: { cohort: true, _count: { select: { enrolments: true } } },
    }),
    db.cohort.findMany({ orderBy: { name: 'asc' } }),
    db.role.findMany({
      where: { assignableLevels: { has: 'COURSE' } },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);
  const self = methods.find((m) => m.type === 'SELF');
  const cohortMethods = methods.filter((m) => m.type === 'COHORT');
  const roleLabel = (r: { name: unknown; shortName: string }) => roleName(r, locale);
  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('manual')}</CardTitle>
          <CardDescription>{t('manualHint')}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('self')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={saveSelfEnrolmentAction} success={tc('saved')} className="grid gap-4">
            <input type="hidden" name="courseId" value={courseId} />
            <label htmlFor="self-enabled" className="flex items-center gap-2 text-sm">
              <Checkbox id="self-enabled" name="enabled" defaultChecked={self?.enabled} />
              {t('selfEnabled')}
            </label>
            <FormField
              name="key"
              label={t('key')}
              hint={t('keyHint')}
              defaultValue={self?.key ?? ''}
              autoComplete="off"
            />
            <label htmlFor="self-groupkeys" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="self-groupkeys"
                name="useGroupKeys"
                defaultChecked={self?.useGroupKeys}
              />
              {t('useGroupKeys')}
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField name="startsAt" label={t('startsAt')}>
                <DateInput
                  id="f-startsAt"
                  name="startsAt"
                  defaultValue={d(self?.startsAt ?? null)}
                />
              </FormField>
              <FormField name="endsAt" label={t('endsAt')}>
                <DateInput id="f-endsAt" name="endsAt" defaultValue={d(self?.endsAt ?? null)} />
              </FormField>
              <FormField
                name="durationDays"
                type="number"
                min={0}
                label={t('durationDays')}
                defaultValue={self?.durationDays ?? ''}
              />
              <FormField
                name="maxEnrolled"
                type="number"
                min={0}
                label={t('maxEnrolled')}
                defaultValue={self?.maxEnrolled ?? ''}
              />
            </div>
            <FormField name="welcome" label={t('welcome')}>
              <Textarea id="f-welcome" name="welcome" defaultValue={self?.welcome ?? ''} />
            </FormField>
            <div>
              <SubmitButton>{tc('save')}</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('cohort')}</CardTitle>
          <CardDescription>{t('cohortHint')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {cohortMethods.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span>
                {m.cohort?.name ?? m.name} · {m._count.enrolments}
              </span>
              <CommandButton
                variant="ghost"
                size="sm"
                run={removeMethodAction.bind(null, courseId, m.id)}
                confirm={t('cohortRemoveConfirm', {
                  name: m.cohort?.name ?? m.name,
                  count: m._count.enrolments,
                })}
              >
                {t('remove')}
              </CommandButton>
            </div>
          ))}
          {cohorts.length ? (
            <ActionForm
              action={addCohortSyncAction}
              success={tc('saved')}
              className="flex flex-wrap items-end gap-2"
            >
              <input type="hidden" name="courseId" value={courseId} />
              <FormField name="cohortId" label={t('cohort')}>
                <Select id="f-cohortId" name="cohortId">
                  {cohorts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField name="roleId" label={tp('role')}>
                <Select
                  id="f-roleId"
                  name="roleId"
                  defaultValue={roles.find((r) => r.shortName === 'student')?.id}
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </Select>
              </FormField>
              <SubmitButton variant="secondary">{t('cohortAdd')}</SubmitButton>
            </ActionForm>
          ) : null}
        </CardContent>
      </Card>
      <Alert>{t('guestHint')}</Alert>
    </div>
  );
}
