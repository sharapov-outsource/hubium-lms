'use client';

import { Checkbox, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { publishPolicyAction, savePolicyAction } from '@/server/actions/privacy';

export function PolicyForm({
  policy,
}: {
  policy?: { id: string; key: string; nameRu: string; nameEn: string };
}) {
  const t = useTranslations('adminPolicies');
  const sfx = policy?.id ?? 'new';
  return (
    <ActionForm
      action={savePolicyAction}
      success={t('saved')}
      resetOnSuccess={!policy}
      className="grid gap-3"
    >
      {policy ? <input type="hidden" name="id" value={policy.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          id={`f-key-${sfx}`}
          name="key"
          label={t('key')}
          defaultValue={policy?.key}
          required
        />
        <FormField
          id={`f-nameRu-${sfx}`}
          name="nameRu"
          label={t('nameRu')}
          defaultValue={policy?.nameRu}
          required
        />
        <FormField
          id={`f-nameEn-${sfx}`}
          name="nameEn"
          label={t('nameEn')}
          defaultValue={policy?.nameEn}
        />
      </div>
      <SubmitButton className="w-fit" variant={policy ? 'secondary' : 'primary'}>
        {policy ? t('save') : t('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function PublishForm({
  policyId,
  content,
}: {
  policyId: string;
  content: { ru: string; en: string };
}) {
  const t = useTranslations('adminPolicies');
  return (
    <ActionForm
      action={publishPolicyAction}
      success={t('publishedOk')}
      className="grid gap-3 border-t pt-4"
    >
      <input type="hidden" name="policyId" value={policyId} />
      <FormField
        id={`f-contentRu-${policyId}`}
        name="contentRu"
        label={t('contentRu')}
        hint={t('markdown')}
      >
        <Textarea
          id={`f-contentRu-${policyId}`}
          name="contentRu"
          rows={8}
          defaultValue={content.ru}
          required
        />
      </FormField>
      <FormField id={`f-contentEn-${policyId}`} name="contentEn" label={t('contentEn')}>
        <Textarea
          id={`f-contentEn-${policyId}`}
          name="contentEn"
          rows={4}
          defaultValue={content.en}
        />
      </FormField>
      <label htmlFor={`mand-${policyId}`} className="flex items-center gap-2 text-sm">
        <Checkbox id={`mand-${policyId}`} name="mandatory" defaultChecked />
        {t('mandatory')}
      </label>
      <SubmitButton className="w-fit">{t('publish')}</SubmitButton>
    </ActionForm>
  );
}
