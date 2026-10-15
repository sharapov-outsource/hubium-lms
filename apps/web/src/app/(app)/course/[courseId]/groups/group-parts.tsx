'use client';

import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { GroupChatButton } from '@/components/comms/message-buttons';
import { CommandButton } from '@/components/confirm-button';
import { deleteGroupAction, groupMembersAction, saveGroupAction } from '@/server/actions/groups';

export function NewGroupForm({ courseId }: { courseId: string }) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const router = useRouter();
  return (
    <ActionForm
      action={saveGroupAction}
      resetOnSuccess
      onSuccess={() => router.refresh()}
      success={tc('saved')}
      className="grid gap-3"
    >
      <input type="hidden" name="courseId" value={courseId} />
      <FormField name="name" label={t('name')} required />
      <FormField name="enrolmentKey" label={t('enrolmentKey')} autoComplete="off" />
      <FormField name="description" label={t('description')} />
      <SubmitButton>{tc('create')}</SubmitButton>
    </ActionForm>
  );
}

export function GroupCard({
  courseId,
  group,
  members,
  candidates,
}: {
  courseId: string;
  group: { id: string; name: string; description: string; enrolmentKey: string };
  members: { id: string; name: string }[];
  candidates: { id: string; name: string }[];
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pick, setPick] = useState('');
  const change = (add: string[], remove: string[]) =>
    start(async () => {
      const r = await groupMembersAction(courseId, group.id, add, remove);
      if (!r.ok) toast.error(r.message);
      setPick('');
      router.refresh();
    });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="break-words">{group.name}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('membersCount', { count: members.length })}
            {group.enrolmentKey ? (
              <>
                {' · '}
                {t('enrolmentKey')}: <code>{group.enrolmentKey}</code>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-1">
          <GroupChatButton groupId={group.id} />
          <CommandButton
            variant="ghost"
            size="sm"
            confirm={t('deleteConfirm', { name: group.name })}
            run={() => deleteGroupAction(courseId, group.id)}
          >
            {tc('delete')}
          </CommandButton>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ul className="flex flex-wrap gap-2">
          {members.map((m) => (
            <li key={m.id}>
              <Badge className="gap-1 pr-1">
                {m.name}
                <button
                  type="button"
                  aria-label={`${t('remove')}: ${m.name}`}
                  className="rounded-full p-0.5 hover:bg-background"
                  onClick={() => change([], [m.id])}
                  disabled={pending}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
        {candidates.length ? (
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label={t('addMembers')}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className="max-w-xs"
            >
              <option value="">{t('choose')}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={!pick || pending}
              onClick={() => change([pick], [])}
            >
              {t('addMembers')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
