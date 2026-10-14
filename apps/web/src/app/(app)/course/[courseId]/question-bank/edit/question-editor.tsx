'use client';

import { EditorField } from '@hubium/editor/field';
import { type Dataset, type Hint, type QuestionType, typeDef } from '@hubium/questions';
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
import { MultipleTries } from './multiple-tries';
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
    penalty: number;
    hints: Hint[];
    /** The datasets the question's category shares (calculated questions). */
    sharedDatasets: Dataset[];
  };
}) {
  const t = useTranslations('qbank');
  const tc = useTranslations('common');
  const part = editorParts[type];
  const [data, setData] = useState<Data>(initial.data ?? part.defaults());
  // a Cloze question's answers are written in its text
  const [text, setText] = useState(initial.text);
  // calculated questions may change the datasets their category shares
  const [shared, setShared] = useState<Dataset[]>(initial.sharedDatasets);
  return (
    <ActionForm action={saveQuestionAction} success={t('saved')} className="grid max-w-3xl gap-5">
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="type" value={type} />
      {initial.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="data" value={JSON.stringify(data)} />
      {initial.sharedDatasets.length || shared.length ? (
        <input type="hidden" name="sharedDatasets" value={JSON.stringify(shared)} />
      ) : null}
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
            onChangeHtml={setText}
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
            <part.Fields
              data={data}
              setData={setData}
              text={text}
              sharedDatasets={shared}
              setSharedDatasets={setShared}
            />
            <DataErrors />
          </CardContent>
        </Card>
      ) : null}
      {typeDef(type).grading === 'auto' ? (
        <MultipleTries
          penalty={initial.penalty}
          hints={initial.hints}
          withParts={!!typeDef(type).parts}
        />
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
  onChangeHtml,
}: {
  name: string;
  label: string;
  defaultValue: string;
  courseId: string;
  small?: boolean;
  onChangeHtml?: (html: string) => void;
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
      onChangeHtml={onChangeHtml}
    />
  );
}
