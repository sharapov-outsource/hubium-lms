'use client';

import type { BulkUploadResult } from '@hubium/core/users/users';
import { Alert } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { uploadUsersAction } from '@/server/actions/admin';

export function UploadForm() {
  const t = useTranslations('admin.user');
  const tc = useTranslations('common');
  const [result, setResult] = useState<BulkUploadResult | null>(null);
  return (
    <div className="grid max-w-xl gap-4">
      <ActionForm action={uploadUsersAction} onSuccess={(r) => setResult(r)} className="grid gap-4">
        <FormField name="file" type="file" accept=".csv,text/csv" label={t('uploadFile')} />
        <div>
          <SubmitButton>{tc('upload')}</SubmitButton>
        </div>
      </ActionForm>
      {result ? (
        <Alert variant={result.errors.length ? 'warning' : 'success'}>
          <p className="font-medium">
            {t('uploadResult', { created: result.created, errors: result.errors.length })}
          </p>
          {result.errors.length ? (
            <ul className="mt-2 list-disc pl-5">
              {result.errors.map((e) => (
                <li key={e.line}>{t('uploadLine', { line: e.line, message: e.message })}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
