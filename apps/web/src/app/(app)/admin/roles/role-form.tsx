'use client';

import type { ActionResult } from '@hubium/core/operation';
import { Checkbox, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';

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
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  role?: { id: string; nameRu: string; nameEn: string; levels: string[]; isProtected: boolean };
  copyFrom?: { id: string; name: string }[];
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
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="nameRu" label={t('nameRu')} defaultValue={role?.nameRu} required />
        <FormField name="nameEn" label={t('nameEn')} defaultValue={role?.nameEn} required />
      </div>
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
