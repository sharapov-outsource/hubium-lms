'use client';

import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { installLanguagePackAction } from '@/server/actions/admin';

export function InstallPackForm() {
  const t = useTranslations('adminLanguages');
  const router = useRouter();
  return (
    <ActionForm
      action={installLanguagePackAction}
      resetOnSuccess
      onSuccess={(r: { name: string; percent: number }) => {
        toast.success(t('installed', { name: r.name, percent: r.percent }));
        router.refresh();
      }}
      className="grid gap-3"
    >
      <FormField
        id="lp-file"
        name="file"
        label={t('packFile')}
        hint={t('installHint')}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        required
      />
      <div>
        <SubmitButton>{t('install')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
