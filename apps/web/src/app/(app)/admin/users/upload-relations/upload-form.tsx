'use client';

import type { RelationUploadResult } from '@hubium/core/users/relations';
import { Alert } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { uploadRelationsAction } from '@/server/actions/mentors';

export function RelationsUploadForm() {
  const t = useTranslations('admin.user.relations');
  const tu = useTranslations('admin.user');
  const tc = useTranslations('common');
  const [result, setResult] = useState<RelationUploadResult | null>(null);
  return (
    <div className="grid max-w-xl gap-4">
      <ActionForm
        action={uploadRelationsAction}
        onSuccess={(r) => setResult(r)}
        className="grid gap-4"
      >
        <FormField name="file" type="file" accept=".csv,text/csv" label={tu('uploadFile')} />
        <div>
          <SubmitButton>{tc('upload')}</SubmitButton>
        </div>
      </ActionForm>
      {result ? (
        <Alert variant={result.errors.length ? 'warning' : 'success'}>
          <p className="font-medium">
            {t('uploadResult', {
              added: result.added,
              removed: result.removed,
              errors: result.errors.length,
            })}
          </p>
          {result.errors.length ? (
            <ul className="mt-2 list-disc pl-5">
              {result.errors.map((e) => (
                <li key={e.line}>{tu('uploadLine', { line: e.line, message: e.message })}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
