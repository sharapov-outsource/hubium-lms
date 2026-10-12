'use client';

import { Checkbox, Textarea } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveLtiToolAction } from '@/server/actions/lti';

interface ToolValues {
  id: string;
  name: string;
  oidcLoginUrl: string;
  targetLinkUri: string;
  redirectUris: string;
  jwksUrl: string;
  publicKeyPem: string;
  deepLinkingUrl: string;
  customParams: string;
  sendName: boolean;
  sendEmail: boolean;
  enabled: boolean;
}

export function ToolForm({ tool }: { tool?: ToolValues }) {
  const t = useTranslations('adminLti');
  const router = useRouter();
  return (
    <ActionForm
      action={saveLtiToolAction}
      success={t('saved')}
      className="grid gap-4"
      onSuccess={() => router.push('/admin/lti')}
    >
      {tool ? <input type="hidden" name="id" value={tool.id} /> : null}
      <FormField name="name" label={t('name')} defaultValue={tool?.name} required />
      <FormField
        name="oidcLoginUrl"
        label={t('loginUrl')}
        type="url"
        defaultValue={tool?.oidcLoginUrl}
        required
      />
      <FormField
        name="targetLinkUri"
        label={t('targetLinkUri')}
        type="url"
        defaultValue={tool?.targetLinkUri}
        required
      />
      <FormField name="redirectUris" label={t('redirectUris')} hint={t('redirectUrisHint')}>
        <Textarea
          id="f-redirectUris"
          name="redirectUris"
          rows={2}
          defaultValue={tool?.redirectUris}
          className="font-mono text-xs"
          required
        />
      </FormField>
      <FormField
        name="jwksUrl"
        label={t('toolJwksUrl')}
        type="url"
        defaultValue={tool?.jwksUrl}
        hint={t('keyHint')}
      />
      <FormField name="publicKeyPem" label={t('publicKey')}>
        <Textarea
          id="f-publicKeyPem"
          name="publicKeyPem"
          rows={3}
          defaultValue={tool?.publicKeyPem}
          className="font-mono text-xs"
          placeholder="-----BEGIN PUBLIC KEY-----"
        />
      </FormField>
      <FormField
        name="deepLinkingUrl"
        label={t('deepLinkingUrl')}
        type="url"
        defaultValue={tool?.deepLinkingUrl}
      />
      <FormField name="customParams" label={t('customParams')}>
        <Textarea
          id="f-customParams"
          name="customParams"
          rows={2}
          defaultValue={tool?.customParams}
          className="font-mono text-xs"
        />
      </FormField>
      <div className="flex flex-wrap gap-4 text-sm">
        <label htmlFor="lt-sendName" className="flex items-center gap-2">
          <Checkbox id="lt-sendName" name="sendName" defaultChecked={tool?.sendName ?? true} />
          {t('sendName')}
        </label>
        <label htmlFor="lt-sendEmail" className="flex items-center gap-2">
          <Checkbox id="lt-sendEmail" name="sendEmail" defaultChecked={tool?.sendEmail ?? false} />
          {t('sendEmail')}
        </label>
        <label htmlFor="lt-enabled" className="flex items-center gap-2">
          <Checkbox id="lt-enabled" name="enabled" defaultChecked={tool?.enabled ?? true} />
          {t('enabled')}
        </label>
      </div>
      <SubmitButton className="w-fit">{t('save')}</SubmitButton>
    </ActionForm>
  );
}
