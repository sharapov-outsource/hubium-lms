'use client';

import type { ActionResult } from '@hubium/core/operation';
import { EditorField } from '@hubium/editor/field';
import { DateInput } from '@hubium/module-sdk/form';
import { Card, CardContent, CardHeader, CardTitle, Checkbox, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { ProfileFieldInputs, type ProfileFieldView } from '@/components/profile-field-inputs';

export interface CourseFormValues {
  id?: string;
  categoryId?: string;
  fullName?: string;
  shortName?: string;
  idNumber?: string | null;
  summary?: string;
  format?: string;
  startDate?: string;
  endDate?: string;
  visible?: boolean;
  lang?: string | null;
  enableCompletion?: boolean;
  groupMode?: string;
  groupModeForced?: boolean;
  guestAccess?: boolean;
  hasImage?: boolean;
}

function Toggle({ name, label, checked }: { name: string; label: string; checked?: boolean }) {
  return (
    <label htmlFor={`c-${name}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`c-${name}`} name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

function SummaryField({ defaultValue, courseId }: { defaultValue?: string; courseId?: string }) {
  const t = useTranslations('course');
  const error = useFieldError('summary');
  return (
    <EditorField
      name="summary"
      label={t('summary')}
      defaultValue={defaultValue}
      courseId={courseId}
      error={error}
      minHeight={120}
    />
  );
}

export function CourseForm({
  action,
  values = {},
  categories,
  languages,
  customFields,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  values?: CourseFormValues;
  categories: { id: string; name: string; depth: number }[];
  /** Enabled languages, by their own names. */
  languages: { code: string; name: string }[];
  /** Custom course fields and the course's values. */
  customFields?: { fields: ProfileFieldView[]; values: Record<string, string | boolean> };
}) {
  const t = useTranslations('course');
  const tc = useTranslations('common');
  const edit = !!values.id;
  return (
    <ActionForm
      action={action}
      success={edit ? t('saved') : undefined}
      className="grid max-w-3xl gap-6"
    >
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormField
            name="fullName"
            label={t('fullName')}
            defaultValue={values.fullName}
            required
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              name="shortName"
              label={t('shortName')}
              hint={t('shortNameHint')}
              defaultValue={values.shortName}
              required
            />
            <FormField name="idNumber" label={t('idNumber')} defaultValue={values.idNumber ?? ''} />
          </div>
          <FormField name="categoryId" label={t('category')}>
            <Select id="f-categoryId" name="categoryId" defaultValue={values.categoryId}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {'  '.repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
          <SummaryField defaultValue={values.summary} courseId={values.id} />
          <FormField
            name="image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            label={t('image')}
          />
          {values.hasImage ? <Toggle name="removeImage" label={tc('delete')} /> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="format" label={t('format')}>
              <Select id="f-format" name="format" defaultValue={values.format ?? 'TOPICS'}>
                {(['TOPICS', 'WEEKS', 'SINGLE'] as const).map((f) => (
                  <option key={f} value={f}>
                    {t(`formats.${f}`)}
                  </option>
                ))}
              </Select>
            </FormField>
            {!edit ? (
              <FormField
                name="sections"
                type="number"
                min={0}
                max={52}
                label={t('sections')}
                defaultValue="4"
              />
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="startDate" label={t('startDate')}>
              <DateInput id="f-startDate" name="startDate" defaultValue={values.startDate} />
            </FormField>
            <FormField name="endDate" label={t('endDate')}>
              <DateInput id="f-endDate" name="endDate" defaultValue={values.endDate} />
            </FormField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="lang" label={t('lang')}>
              <Select id="f-lang" name="lang" defaultValue={values.lang ?? ''}>
                <option value="">{t('langAuto')}</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code} lang={l.code}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField name="groupMode" label={t('groupMode')}>
              <Select id="f-groupMode" name="groupMode" defaultValue={values.groupMode ?? 'NONE'}>
                {(['NONE', 'SEPARATE', 'VISIBLE'] as const).map((g) => (
                  <option key={g} value={g}>
                    {t(`groupModes.${g}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className="grid gap-2">
            <Toggle name="visible" label={t('visible')} checked={values.visible ?? true} />
            <Toggle
              name="enableCompletion"
              label={t('enableCompletion')}
              checked={values.enableCompletion ?? true}
            />
            <Toggle
              name="groupModeForced"
              label={t('groupModeForced')}
              checked={values.groupModeForced}
            />
            <Toggle name="guestAccess" label={t('guestAccess')} checked={values.guestAccess} />
          </div>
        </CardContent>
      </Card>
      {customFields?.fields.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('customFields')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ProfileFieldInputs fields={customFields.fields} values={customFields.values} />
          </CardContent>
        </Card>
      ) : null}
      <div>
        <SubmitButton>{edit ? tc('save') : tc('create')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
