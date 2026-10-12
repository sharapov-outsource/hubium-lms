'use client';

import { EditorField } from '@hubium/editor/field';
import { DateTimeInput } from '@hubium/module-sdk/form';
import { Button, Card, CardContent, Checkbox, Field, Select } from '@hubium/ui';
import { Megaphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveAnnouncementAction } from '@/server/actions/announcements';

/** Collapsible form for a new course or site announcement. */
export function AnnouncementComposer({
  courseId,
  groups = [],
}: {
  courseId: string | null;
  groups?: { id: string; name: string }[];
}) {
  const t = useTranslations('announcements');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        <Megaphone aria-hidden />
        {t('new')}
      </Button>
    );
  return (
    <Card>
      <CardContent className="pt-6">
        <ActionForm
          key={key}
          action={saveAnnouncementAction}
          className="grid gap-4"
          onSuccess={() => {
            setKey((k) => k + 1);
            setOpen(false);
          }}
          success={t('posted')}
        >
          {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
          <FormField name="title" label={t('subject')} required maxLength={255} />
          <EditorField
            name="contentHtml"
            label={t('content')}
            minHeight={140}
            courseId={courseId ?? undefined}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('publishAt')} htmlFor="an-publishAt" hint={t('publishAtHint')}>
              <DateTimeInput id="an-publishAt" name="publishAt" />
            </Field>
            {groups.length ? (
              <Field label={t('group')} htmlFor="an-group">
                <Select id="an-group" name="groupId" defaultValue="">
                  <option value="">{t('allGroups')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-4">
            <label htmlFor="an-notify" className="flex items-center gap-2 text-sm">
              <Checkbox id="an-notify" name="notify" defaultChecked />
              {t('notify')}
            </label>
            <label htmlFor="an-pinned" className="flex items-center gap-2 text-sm">
              <Checkbox id="an-pinned" name="pinned" />
              {t('pin')}
            </label>
          </div>
          <div className="flex gap-2">
            <SubmitButton>{t('new')}</SubmitButton>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {tc('cancel')}
            </Button>
          </div>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
