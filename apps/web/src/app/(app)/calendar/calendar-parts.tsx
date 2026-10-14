'use client';

import { LocalDateTimeInput } from '@hubium/module-sdk/form';
import { Button, Checkbox, Input, Select, Textarea } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { createEventAction, resetFeedTokenAction } from '@/server/actions/calendar';

export function NewEventForm({
  courses,
  canSite,
}: {
  courses: { id: string; fullName: string }[];
  canSite: boolean;
}) {
  const t = useTranslations('calendar');
  const tc = useTranslations('common');
  const router = useRouter();
  const [scope, setScope] = useState('USER');
  return (
    <ActionForm
      action={createEventAction}
      success={tc('saved')}
      resetOnSuccess
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      <FormField name="title" label={t('eventTitle')} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField name="startsAt" label={t('startsAt')}>
          <LocalDateTimeInput id="f-startsAt" name="startsAt" required defaultTime="09:00" />
        </FormField>
        <FormField name="endsAt" label={t('endsAt')}>
          <LocalDateTimeInput id="f-endsAt" name="endsAt" defaultTime="10:00" />
        </FormField>
      </div>
      <label htmlFor="ev-allday" className="flex items-center gap-2 text-sm">
        <Checkbox id="ev-allday" name="allDay" />
        {t('allDay')}
      </label>
      <FormField name="scope" label={t('scope')}>
        <Select id="f-scope" name="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="USER">{t('scopes.USER')}</option>
          {courses.length ? <option value="COURSE">{t('scopes.COURSE')}</option> : null}
          {canSite ? <option value="SITE">{t('scopes.SITE')}</option> : null}
        </Select>
      </FormField>
      {scope === 'COURSE' ? (
        <FormField name="courseId" label={t('course')}>
          <Select id="f-courseId" name="courseId">
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
      <FormField name="description" label={t('eventDescription')}>
        <Textarea id="f-description" name="description" className="min-h-16" />
      </FormField>
      <SubmitButton>{tc('create')}</SubmitButton>
    </ActionForm>
  );
}

export function FeedLink({ baseUrl }: { baseUrl: string }) {
  const t = useTranslations('calendar');
  const [url, setUrl] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">{t('feedHint')}</p>
      {url ? (
        <Input
          readOnly
          value={url}
          aria-label={t('feed')}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : null}
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await resetFeedTokenAction();
            if (r.ok)
              setUrl(`${baseUrl || window.location.origin}/api/calendar/ical/${r.data.token}.ics`);
          })
        }
      >
        {t('feedReset')}
      </Button>
    </div>
  );
}
