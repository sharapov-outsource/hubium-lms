'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Checkbox, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';

export interface UserFormValues {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  username?: string | null;
  locale?: string | null;
  timezone?: string | null;
  isSiteAdmin?: boolean;
}

export function UserForm({
  action,
  values = {},
  canSetAdmin,
  mode,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  values?: UserFormValues;
  canSetAdmin: boolean;
  mode: 'create' | 'edit';
}) {
  const t = useTranslations('admin.user');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  return (
    <ActionForm
      action={action}
      success={mode === 'edit' ? t('updated') : undefined}
      className="grid max-w-xl gap-4"
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="firstName"
          label={ta('firstName')}
          defaultValue={values.firstName}
          required
        />
        <FormField name="lastName" label={ta('lastName')} defaultValue={values.lastName} required />
      </div>
      <FormField
        name="email"
        type="email"
        label={ta('email')}
        defaultValue={values.email}
        hint={mode === 'create' ? t('emailOrUsername') : undefined}
      />
      {mode === 'create' ? (
        <FormField
          name="username"
          label={ta('username')}
          defaultValue={values.username ?? ''}
          autoComplete="off"
        />
      ) : null}
      <FormField
        name="password"
        type="password"
        label={ta('password')}
        hint={mode === 'edit' ? t('passwordHint') : ta('passwordHint')}
        autoComplete="new-password"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="locale" label={tc('language')}>
          <Select id="f-locale" name="locale" defaultValue={values.locale ?? ''}>
            <option value="">—</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </Select>
        </FormField>
        <FormField
          name="timezone"
          label="Timezone"
          defaultValue={values.timezone ?? ''}
          placeholder="Europe/Moscow"
        />
      </div>
      {canSetAdmin ? (
        <label htmlFor="isSiteAdmin" className="flex items-center gap-2 text-sm">
          <Checkbox id="isSiteAdmin" name="isSiteAdmin" defaultChecked={values.isSiteAdmin} />
          {t('isSiteAdmin')}
        </label>
      ) : null}
      <div>
        <SubmitButton>{mode === 'create' ? tc('create') : tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
