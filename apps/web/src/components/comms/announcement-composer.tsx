'use client';

import { EditorField } from '@hubium/editor/field';
import { DateTimeInput } from '@hubium/module-sdk/form';
import { Button, Card, CardContent, Checkbox, Field, Select } from '@hubium/ui';
import { Dialog, DialogContent, DialogTrigger } from '@hubium/ui/dialog';
import { Megaphone, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveAnnouncementAction } from '@/server/actions/announcements';

/** An announcement as the form edits it. */
export interface AnnouncementDraft {
  id: string;
  title: string;
  contentHtml: string;
  /** ISO time: still to come when it is scheduled. */
  publishAt: string;
  groupId: string | null;
  pinned: boolean;
  notify: boolean;
}

/** The fields of a new announcement, or of one being edited. */
function AnnouncementForm({
  courseId,
  groups,
  initial,
  onDone,
}: {
  courseId: string | null;
  groups: { id: string; name: string }[];
  initial?: AnnouncementDraft;
  onDone: () => void;
}) {
  const t = useTranslations('announcements');
  const tc = useTranslations('common');
  // a published announcement keeps its date; a scheduled one may move
  const scheduled = !initial || new Date(initial.publishAt) > new Date();
  return (
    <ActionForm
      action={saveAnnouncementAction}
      className="grid gap-4"
      onSuccess={onDone}
      success={initial ? t('saved') : t('posted')}
    >
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
      <FormField
        name="title"
        label={t('subject')}
        required
        maxLength={255}
        defaultValue={initial?.title}
      />
      <EditorField
        name="contentHtml"
        label={t('content')}
        minHeight={140}
        courseId={courseId ?? undefined}
        defaultValue={initial?.contentHtml}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {scheduled ? (
          <Field label={t('publishAt')} htmlFor="an-publishAt" hint={t('publishAtHint')}>
            <DateTimeInput
              id="an-publishAt"
              name="publishAt"
              defaultValue={initial?.publishAt ?? null}
            />
          </Field>
        ) : null}
        {groups.length ? (
          <Field label={t('group')} htmlFor="an-group">
            <Select id="an-group" name="groupId" defaultValue={initial?.groupId ?? ''}>
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
          <Checkbox id="an-notify" name="notify" defaultChecked={initial?.notify ?? true} />
          {t('notify')}
        </label>
        <label htmlFor="an-pinned" className="flex items-center gap-2 text-sm">
          <Checkbox id="an-pinned" name="pinned" defaultChecked={initial?.pinned ?? false} />
          {t('pin')}
        </label>
      </div>
      <div className="flex gap-2">
        <SubmitButton>{initial ? t('save') : t('new')}</SubmitButton>
        <Button type="button" variant="ghost" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
    </ActionForm>
  );
}

/** Collapsible form for a new course or site announcement. */
export function AnnouncementComposer({
  courseId,
  groups = [],
}: {
  courseId: string | null;
  groups?: { id: string; name: string }[];
}) {
  const t = useTranslations('announcements');
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
        <AnnouncementForm
          key={key}
          courseId={courseId}
          groups={groups}
          onDone={() => {
            setKey((k) => k + 1);
            setOpen(false);
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Edits an announcement in a dialog. */
export function AnnouncementEditButton({
  courseId,
  groups = [],
  announcement,
}: {
  courseId: string | null;
  groups?: { id: string; name: string }[];
  announcement: AnnouncementDraft;
}) {
  const t = useTranslations('announcements');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={t('edit')}>
          <Pencil aria-hidden />
        </Button>
      </DialogTrigger>
      <DialogContent title={t('edit')} className="max-w-2xl">
        <AnnouncementForm
          courseId={courseId}
          groups={groups}
          initial={announcement}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
