'use client';

import { Select } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { autoGroupsAction } from '@/server/actions/groups';

/** Groups made from the course's people: a number of groups, or groups of a size. */
export function AutoGroupsForm({
  courseId,
  roles,
  defaultRoleId,
}: {
  courseId: string;
  roles: { id: string; name: string }[];
  defaultRoleId?: string;
}) {
  const t = useTranslations('groups.auto');
  const router = useRouter();
  return (
    <ActionForm
      action={autoGroupsAction}
      success={t('done')}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      <input type="hidden" name="courseId" value={courseId} />
      <FormField name="roleId" label={t('role')}>
        <Select id="f-roleId" name="roleId" defaultValue={defaultRoleId}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </FormField>
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <FormField name="by" label={t('by')}>
          <Select id="f-by" name="by" defaultValue="count">
            <option value="count">{t('byCount')}</option>
            <option value="size">{t('bySize')}</option>
          </Select>
        </FormField>
        <FormField name="number" label={t('number')} type="number" min={1} defaultValue={2} />
      </div>
      <FormField
        name="pattern"
        label={t('pattern')}
        hint={t('patternHint')}
        defaultValue={t('defaultPattern')}
      />
      <FormField name="order" label={t('order')}>
        <Select id="f-order" name="order" defaultValue="random">
          <option value="random">{t('random')}</option>
          <option value="name">{t('byName')}</option>
        </Select>
      </FormField>
      <FormField name="grouping" label={t('grouping')} hint={t('groupingHint')} />
      <div>
        <SubmitButton>{t('create')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
