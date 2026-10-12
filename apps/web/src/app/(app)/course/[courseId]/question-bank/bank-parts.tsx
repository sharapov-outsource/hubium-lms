'use client';

import { Alert, Input, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  deleteQuestionAction,
  importGiftAction,
  saveQuestionCategoryAction,
} from '@/server/actions/grades';

export function CategoryForm({ courseId }: { courseId: string }) {
  const t = useTranslations('qbank');
  return (
    <ActionForm action={saveQuestionCategoryAction} resetOnSuccess className="mt-2 flex gap-2">
      <input type="hidden" name="courseId" value={courseId} />
      <label htmlFor="newcat" className="sr-only">
        {t('newCategory')}
      </label>
      <Input id="newcat" name="name" placeholder={t('newCategory')} className="h-8" required />
      <SubmitButton size="sm" variant="secondary">
        +
      </SubmitButton>
    </ActionForm>
  );
}

export function DeleteQuestionButton({ courseId, id }: { courseId: string; id: string }) {
  const t = useTranslations('qbank');
  return (
    <CommandButton
      size="sm"
      variant="ghost"
      confirm={t('deleteConfirm')}
      run={() => deleteQuestionAction(courseId, id)}
    >
      {t('remove')}
    </CommandButton>
  );
}

export function GiftImportForm({ courseId, categoryId }: { courseId: string; categoryId: string }) {
  const t = useTranslations('qbank');
  const tc = useTranslations('common');
  const [result, setResult] = useState<{
    created: number;
    errors: { block: number; message: string }[];
  } | null>(null);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('importHint')}</p>
      <ActionForm
        action={importGiftAction}
        onSuccess={(r) => setResult(r)}
        resetOnSuccess
        className="grid gap-3"
      >
        <input type="hidden" name="courseId" value={courseId} />
        <input type="hidden" name="categoryId" value={categoryId} />
        <FormField name="gift" label="GIFT">
          <Textarea
            id="f-gift"
            name="gift"
            className="min-h-32 font-mono text-xs"
            placeholder="::Q1:: 2 + 2 = ? {=4 ~3 ~5}"
          />
        </FormField>
        <FormField
          name="file"
          type="file"
          accept=".txt,.gift,.xml,text/plain,text/xml,application/xml"
          label={t('importFile')}
        />
        <SubmitButton className="w-fit">{tc('upload')}</SubmitButton>
      </ActionForm>
      {result ? (
        <Alert variant={result.errors.length ? 'warning' : 'success'}>
          {t('importResult', { created: result.created, errors: result.errors.length })}
          {result.errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {result.errors.map((e) => (
                <li key={`${e.block}-${e.message}`}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
