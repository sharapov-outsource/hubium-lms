'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Checkbox, Combobox, type ComboboxOption, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { ProfileFieldInputs, type ProfileFieldView } from '@/components/profile-field-inputs';
import { type PasswordRules, passwordHint } from '@/lib/password-hint';

export interface UserFormValues {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  username?: string | null;
  locale?: string | null;
  timezone?: string | null;
  isSiteAdmin?: boolean;
  customFields?: Record<string, string | boolean>;
}

export function UserForm({
  action,
  values = {},
  canSetAdmin,
  mode,
  profileFields = [],
  languages,
  timezones,
  passwordRules,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  values?: UserFormValues;
  canSetAdmin: boolean;
  mode: 'create' | 'edit';
  profileFields?: ProfileFieldView[];
  /** Enabled languages, by their own names. */
  languages: { code: string; name: string }[];
  /** IANA zones to choose from (server/timezones.ts). */
  timezones: ComboboxOption[];
  passwordRules: PasswordRules;
}) {
  const t = useTranslations('admin.user');
  const tp = useTranslations('profileFields');
  const ta = useTranslations('auth');
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
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
        hint={
          mode === 'edit'
            ? `${t('passwordHint')}. ${passwordHint(ta, passwordRules)}`
            : passwordHint(ta, passwordRules)
        }
        autoComplete="new-password"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="locale" label={tc('language')}>
          <Select id="f-locale" name="locale" defaultValue={values.locale ?? ''}>
            <option value="">—</option>
            {languages.map((l) => (
              <option key={l.code} value={l.code} lang={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField name="timezone" label={ts('timezone')}>
          <Combobox
            id="f-timezone"
            name="timezone"
            defaultValue={values.timezone ?? ''}
            options={[{ value: '', label: ts('timezoneDefault') }, ...timezones]}
          />
        </FormField>
      </div>
      {profileFields.length ? (
        <fieldset className="grid gap-4">
          <legend className="mb-1 text-sm font-semibold">{tp('section')}</legend>
          <ProfileFieldInputs fields={profileFields} values={values.customFields ?? {}} />
        </fieldset>
      ) : null}
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
