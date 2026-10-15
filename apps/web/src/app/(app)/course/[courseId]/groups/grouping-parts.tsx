'use client';

import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  deleteGroupingAction,
  groupingGroupsAction,
  saveGroupingAction,
} from '@/server/actions/groups';

export function NewGroupingForm({ courseId }: { courseId: string }) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const router = useRouter();
  return (
    <ActionForm
      action={saveGroupingAction}
      resetOnSuccess
      onSuccess={() => router.refresh()}
      success={tc('saved')}
      className="grid gap-3"
    >
      <input type="hidden" name="courseId" value={courseId} />
      <FormField id="f-grouping-name" name="name" label={t('name')} required />
      <FormField id="f-grouping-description" name="description" label={t('description')} />
      <SubmitButton>{tc('create')}</SubmitButton>
    </ActionForm>
  );
}

export function GroupingCard({
  courseId,
  grouping,
  groups,
}: {
  courseId: string;
  grouping: { id: string; name: string; description: string; groupIds: string[]; used: number };
  groups: { id: string; name: string }[];
}) {
  const t = useTranslations('groups');
  const tc = useTranslations('common');
  const router = useRouter();
  const [chosen, setChosen] = useState(new Set(grouping.groupIds));
  const [pending, start] = useTransition();
  const dirty =
    chosen.size !== grouping.groupIds.length || grouping.groupIds.some((g) => !chosen.has(g));
  const save = () =>
    start(async () => {
      const r = await groupingGroupsAction(courseId, grouping.id, [...chosen]);
      if (r.ok) toast.success(tc('saved'));
      else toast.error(r.message);
      router.refresh();
    });
  return (
    <Card role="region" aria-label={grouping.name}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="break-words">{grouping.name}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {[grouping.description, grouping.used ? t('usedBy', { count: grouping.used }) : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <CommandButton
          variant="ghost"
          size="sm"
          confirm={t('groupingDeleteConfirm', { name: grouping.name })}
          run={() => deleteGroupingAction(courseId, grouping.id)}
        >
          {tc('delete')}
        </CommandButton>
      </CardHeader>
      <CardContent className="grid gap-3">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t('groupingGroups')}</legend>
          {groups.map((g) => {
            const id = `gg-${grouping.id}-${g.id}`;
            return (
              <label key={g.id} htmlFor={id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  id={id}
                  checked={chosen.has(g.id)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setChosen((s) => {
                      const next = new Set(s);
                      if (on) next.add(g.id);
                      else next.delete(g.id);
                      return next;
                    });
                  }}
                />
                {g.name}
              </label>
            );
          })}
        </fieldset>
        <Button variant="secondary" className="w-fit" disabled={!dirty || pending} onClick={save}>
          {tc('save')}
        </Button>
      </CardContent>
    </Card>
  );
}
