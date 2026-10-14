'use client';

import { EditorField } from '@hubium/editor/field';
import type { QuestionType } from '@hubium/questions';
import { Card, CardContent, CardHeader, CardTitle, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  ActionForm,
  FormField,
  SubmitButton,
  useFieldError,
  useFormErrors,
} from '@/components/action-form';
import { saveQuestionAction } from '@/server/actions/grades';
import { type Data, editorParts } from './qtypes';

function DataErrors() {
  const errors = useFormErrors();
  const all = Object.entries(errors)
    .filter(([k]) => k === 'data' || k.startsWith('data.'))
    .map(([k, v]) => `${k.replace(/^data\.?/, '')} ${v.join(', ')}`.trim());
  return all.length ? (
    <p className="text-xs text-destructive" role="alert">
      {all.join('; ')}
    </p>
  ) : null;
}

export function QuestionEditor({
  courseId,
  type,
  categories,
  initial,
}: {
  courseId: string;
  type: QuestionType;
  categories: { id: string; name: string }[];
  initial: {
    id?: string;
    categoryId: string;
    name: string;
    text: string;
    generalFeedback: string;
    defaultMark: number;
    status: string;
    data: Data | null;
  };
}) {
  const t = useTranslations('qbank');
  const tc = useTranslations('common');
  const part = editorParts[type];
  const [data, setData] = useState<Data>(initial.data ?? part.defaults());
  return (
    <ActionForm action={saveQuestionAction} success={t('saved')} className="grid max-w-3xl gap-5">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="type" value={type} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="data" value={JSON.stringify(data)} />
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="categoryId" label={t('category')}>
              <Select id="f-categoryId" name="categoryId" defaultValue={initial.categoryId}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField name="status" label={t('status')}>
              <Select id="f-status" name="status" defaultValue={initial.status}>
                {(['READY', 'DRAFT', 'HIDDEN'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`statuses.${s}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField name="name" label={t('name')} defaultValue={initial.name} required />
          <TextField
            name="text"
            label={t('text')}
            defaultValue={initial.text}
            courseId={courseId}
          />
          {type !== 'DESCRIPTION' ? (
            <FormField
              name="defaultMark"
              type="number"
              step="any"
              min={0}
              label={t('defaultMark')}
              defaultValue={initial.defaultMark}
              className="w-40"
            />
          ) : null}
        </CardContent>
      </Card>
      {part.Fields ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('answers')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <part.Fields data={data} setData={setData} />
            <DataErrors />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="pt-5">
          <TextField
            name="generalFeedback"
            label={t('generalFeedback')}
            defaultValue={initial.generalFeedback}
            courseId={courseId}
            small
          />
        </CardContent>
      </Card>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

function TextField({
  name,
  label,
  defaultValue,
  courseId,
  small,
}: {
  name: string;
  label: string;
  defaultValue: string;
  courseId: string;
  small?: boolean;
}) {
  const error = useFieldError(name);
  return (
    <EditorField
      name={name}
      label={label}
      defaultValue={defaultValue}
      courseId={courseId}
      error={error}
      minHeight={small ? 80 : 140}
    />
  );
}
