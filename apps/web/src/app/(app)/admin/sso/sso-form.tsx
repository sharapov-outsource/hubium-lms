'use client';

import { Checkbox, Select, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveSsoProviderAction } from '@/server/actions/sso';

export interface SsoFormValues {
  id?: string;
  providerId?: string;
  name?: string;
  protocol?: 'oidc' | 'saml';
  enabled?: boolean;
  autoCreate?: boolean;
  linkByEmail?: boolean;
  domain?: string;
  issuer?: string;
  clientId?: string;
  hasSecret?: boolean;
  scopes?: string;
  mapping?: {
    email?: string;
    firstName?: string;
    lastName?: string;
    fields?: Record<string, string>;
  };
}

function Toggle({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label htmlFor={`t-${name}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`t-${name}`} name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

/** The addresses an identity provider needs, for the identifier being typed. */
function Endpoints({
  appUrl,
  providerId,
  protocol,
}: {
  appUrl: string;
  providerId: string;
  protocol: 'oidc' | 'saml';
}) {
  const t = useTranslations('adminSso');
  const id = providerId || '…';
  const rows =
    protocol === 'oidc'
      ? [[t('redirectUri'), `${appUrl}/api/auth/sso/callback/${id}`]]
      : [
          [t('spEntityId'), `${appUrl}/api/auth/sso/saml2/sp/metadata?providerId=${id}`],
          [t('acsUrl'), `${appUrl}/api/auth/sso/saml2/sp/acs/${id}`],
        ];
  return (
    <dl className="grid gap-2 rounded-lg border border-border p-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-0.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>
            <code className="select-all break-all text-xs">{value}</code>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SsoForm({
  values = {},
  appUrl,
  profileFields,
}: {
  values?: SsoFormValues;
  appUrl: string;
  profileFields: { shortName: string; label: string }[];
}) {
  const t = useTranslations('adminSso');
  const tc = useTranslations('common');
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>(values.protocol ?? 'oidc');
  const [providerId, setProviderId] = useState(values.providerId ?? '');
  const m = values.mapping ?? {};
  return (
    <ActionForm action={saveSsoProviderAction} className="grid max-w-2xl gap-4">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <FormField name="protocol" label={t('protocol')}>
        <Select
          id="f-protocol"
          name={values.id ? undefined : 'protocol'}
          value={protocol}
          disabled={!!values.id}
          onChange={(e) => setProtocol(e.currentTarget.value === 'saml' ? 'saml' : 'oidc')}
        >
          <option value="oidc">OpenID Connect</option>
          <option value="saml">SAML 2.0</option>
        </Select>
      </FormField>
      {values.id ? <input type="hidden" name="protocol" value={protocol} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="name" label={t('name')} hint={t('nameHint')} defaultValue={values.name} />
        <FormField
          name="providerId"
          label={t('providerId')}
          hint={t('providerIdHint')}
          value={providerId}
          readOnly={!!values.id}
          onChange={(e) => setProviderId(e.currentTarget.value.trim().toLowerCase())}
        />
      </div>
      <Endpoints appUrl={appUrl} providerId={providerId} protocol={protocol} />

      {protocol === 'oidc' ? (
        <fieldset className="grid gap-4">
          <legend className="mb-2 font-semibold">OpenID Connect</legend>
          <FormField
            name="issuer"
            type="url"
            label={t('issuer')}
            hint={t('issuerHint')}
            defaultValue={values.issuer}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField name="clientId" label={t('clientId')} defaultValue={values.clientId} />
            <FormField
              name="clientSecret"
              type="password"
              autoComplete="off"
              label={t('clientSecret')}
              hint={values.hasSecret ? t('clientSecretKept') : undefined}
            />
          </div>
          <FormField
            name="scopes"
            label={t('scopes')}
            placeholder="openid email profile"
            defaultValue={values.scopes}
          />
        </fieldset>
      ) : (
        <fieldset className="grid gap-4">
          <legend className="mb-2 font-semibold">SAML 2.0</legend>
          <FormField
            name="idpMetadataUrl"
            type="url"
            label={t('idpMetadataUrl')}
            hint={values.id ? t('idpMetadataKept') : t('idpMetadataHint')}
          />
          <FormField name="idpMetadataXml" label={t('idpMetadataXml')}>
            <Textarea id="f-idpMetadataXml" name="idpMetadataXml" rows={4} className="font-mono" />
          </FormField>
        </fieldset>
      )}

      <fieldset className="grid gap-3">
        <legend className="mb-2 font-semibold">{t('accounts')}</legend>
        <Toggle name="enabled" label={t('enabled')} checked={values.enabled ?? true} />
        <Toggle name="linkByEmail" label={t('linkByEmail')} checked={values.linkByEmail ?? true} />
        <Toggle name="autoCreate" label={t('autoCreate')} checked={values.autoCreate ?? false} />
        <FormField
          name="domain"
          label={t('domain')}
          hint={t('domainHint')}
          defaultValue={values.domain}
        />
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-1 font-semibold">{t('mapping')}</legend>
        <p className="text-sm text-muted-foreground">
          {protocol === 'oidc' ? t('mappingHintOidc') : t('mappingHintSaml')}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            name="mapEmail"
            label={t('mapEmail')}
            placeholder="email"
            defaultValue={m.email}
          />
          <FormField
            name="mapFirstName"
            label={t('mapFirstName')}
            placeholder={protocol === 'oidc' ? 'given_name' : 'firstName'}
            defaultValue={m.firstName}
          />
          <FormField
            name="mapLastName"
            label={t('mapLastName')}
            placeholder={protocol === 'oidc' ? 'family_name' : 'lastName'}
            defaultValue={m.lastName}
          />
        </div>
        {profileFields.length ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {profileFields.map((f) => (
              <FormField
                key={f.shortName}
                name={`map_field_${f.shortName}`}
                label={f.label}
                defaultValue={m.fields?.[f.shortName]}
              />
            ))}
          </div>
        ) : null}
      </fieldset>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
