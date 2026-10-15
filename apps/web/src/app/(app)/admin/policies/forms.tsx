'use client';

import { Checkbox, Textarea } from '@hubium/ui';
import { useLocale, useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { type LanguageOption, LocalizedFields } from '@/components/localized-fields';
import { publishPolicyAction, savePolicyAction } from '@/server/actions/privacy';

export function PolicyForm({
  policy,
  languages,
}: {
  policy?: { id: string; key: string; name: Record<string, string> };
  /** Languages of the texts: the site language first. */
  languages: LanguageOption[];
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
      <FormField
        id={`f-key-${sfx}`}
        name="key"
        label={t('key')}
        defaultValue={policy?.key}
        required
        className="sm:max-w-xs"
      />
      <LocalizedFields
        name="name"
        label={t('name')}
        languages={languages}
        values={policy?.name}
        idSuffix={`-${sfx}`}
        maxLength={200}
      />
      <SubmitButton className="w-fit" variant={policy ? 'secondary' : 'primary'}>
        {policy ? t('save') : t('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function PublishForm({
  policyId,
  content,
  mandatory,
  languages,
}: {
  policyId: string;
  content: Record<string, string>;
  /** Whether the current version must be accepted; a first version must be by default. */
  mandatory: boolean;
  languages: LanguageOption[];
}) {
  const t = useTranslations('adminPolicies');
  const tc = useTranslations('common');
  const locale = useLocale();
  const named = (code: string, own: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? own;
    } catch {
      return own;
    }
  };
  return (
    <ActionForm
      action={publishPolicyAction}
      success={t('publishedOk')}
      className="grid gap-3 border-t pt-4"
    >
      <input type="hidden" name="policyId" value={policyId} />
      {languages.map((l, i) => {
        const id = `f-content-${l.code}-${policyId}`;
        return (
          <FormField
            key={l.code}
            id={id}
            name={`content_${l.code}`}
            label={tc('inLanguage', { label: t('content'), language: named(l.code, l.name) })}
            hint={i === 0 ? t('markdown') : undefined}
          >
            <Textarea
              id={id}
              name={`content_${l.code}`}
              lang={l.code}
              rows={i === 0 ? 8 : 4}
              defaultValue={content[l.code] ?? ''}
              required={i === 0}
            />
          </FormField>
        );
      })}
      <label htmlFor={`mand-${policyId}`} className="flex items-center gap-2 text-sm">
        <Checkbox id={`mand-${policyId}`} name="mandatory" defaultChecked={mandatory} />
        {t('mandatory')}
      </label>
      <p className="text-xs text-muted-foreground">{t('mandatoryHint')}</p>
      <SubmitButton className="w-fit">{t('publish')}</SubmitButton>
    </ActionForm>
  );
}
