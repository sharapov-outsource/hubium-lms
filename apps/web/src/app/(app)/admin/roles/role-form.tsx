'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Checkbox, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { type LanguageOption, LocalizedFields } from '@/components/localized-fields';

const LEVELS = ['SYSTEM', 'CATEGORY', 'COURSE', 'ACTIVITY'] as const;
const ARCHETYPES = [
  'MANAGER',
  'COURSECREATOR',
  'EDITINGTEACHER',
  'TEACHER',
  'STUDENT',
  'OBSERVER',
  'NONE',
] as const;

export function RoleForm({
  action,
  role,
  copyFrom = [],
  languages,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  role?: {
    id: string;
    name: Record<string, string>;
    levels: string[];
    isProtected: boolean;
  };
  copyFrom?: { id: string; name: string }[];
  /** Languages of the name: the site language first. */
  languages: LanguageOption[];
}) {
  const t = useTranslations('admin.role');
  const tc = useTranslations('common');
  return (
    <ActionForm
      action={action}
      success={role ? tc('saved') : undefined}
      className="grid max-w-xl gap-4"
    >
      {role ? <input type="hidden" name="id" value={role.id} /> : null}
      {!role ? (
        <FormField
          name="shortName"
          label={t('shortName')}
          placeholder="tutor"
          pattern="[a-z][a-z0-9_]+"
          required
        />
      ) : null}
      <LocalizedFields
        name="name"
        label={t('name')}
        languages={languages}
        values={role?.name}
        maxLength={100}
      />
      {!role ? (
        <>
          <FormField name="archetype" label={t('archetype')}>
            <Select id="f-archetype" name="archetype" defaultValue="NONE">
              {ARCHETYPES.map((a) => (
                <option key={a} value={a}>
                  {t(`archetypes.${a}`)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField name="copyFromRoleId" label={t('copyFrom')}>
            <Select id="f-copyFromRoleId" name="copyFromRoleId" defaultValue="">
              <option value="">—</option>
              {copyFrom.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </FormField>
        </>
      ) : null}
      {!role?.isProtected ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{t('assignableLevels')}</legend>
          {LEVELS.map((l) => (
            <label key={l} htmlFor={`level_${l}`} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`level_${l}`}
                name={`level_${l}`}
                defaultChecked={role?.levels.includes(l)}
              />
              {t(`levels.${l}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div>
        <SubmitButton>{role ? tc('save') : tc('create')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
