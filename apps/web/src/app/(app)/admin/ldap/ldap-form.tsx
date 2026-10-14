'use client';

import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Textarea,
} from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveLdapAction, syncLdapAction, testLdapAction } from '@/server/actions/ldap';

export interface LdapFormValues {
  enabled: boolean;
  url: string;
  startTls: boolean;
  caCertificate: string;
  bindDn: string;
  hasPassword: boolean;
  baseDn: string;
  userFilter: string;
  loginAttribute: string;
  idAttribute: string;
  mapping: {
    email?: string;
    firstName?: string;
    lastName?: string;
    fields?: Record<string, string>;
  };
  autoCreate: boolean;
  linkByEmail: boolean;
  suspendMissing: boolean;
}

function Toggle({ name, label, checked }: { name: string; label: string; checked: boolean }) {
  return (
    <label htmlFor={`t-${name}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`t-${name}`} name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}

export function LdapForm({
  values,
  profileFields,
}: {
  values?: LdapFormValues;
  profileFields: { shortName: string; label: string }[];
}) {
  const t = useTranslations('adminLdap');
  const tc = useTranslations('common');
  const v = values;
  const m = v?.mapping ?? {};
  return (
    <ActionForm action={saveLdapAction} success={tc('saved')} className="grid gap-4">
      <Toggle name="enabled" label={t('enabled')} checked={v?.enabled ?? false} />
      <fieldset className="grid gap-4">
        <legend className="mb-2 font-semibold">{t('connection')}</legend>
        <FormField
          name="url"
          label={t('url')}
          hint={t('urlHint')}
          placeholder="ldaps://ldap.example.org:636"
          defaultValue={v?.url}
        />
        <Toggle name="startTls" label={t('startTls')} checked={v?.startTls ?? false} />
        <FormField name="caCertificate" label={t('caCertificate')} hint={t('caCertificateHint')}>
          <Textarea
            id="f-caCertificate"
            name="caCertificate"
            rows={3}
            className="font-mono"
            defaultValue={v?.caCertificate}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="bindDn"
            label={t('bindDn')}
            placeholder="cn=hubium,ou=services,dc=example,dc=org"
            defaultValue={v?.bindDn}
          />
          <FormField
            name="bindPassword"
            type="password"
            autoComplete="off"
            label={t('bindPassword')}
            hint={v?.hasPassword ? t('bindPasswordKept') : undefined}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 font-semibold">{t('people')}</legend>
        <FormField
          name="baseDn"
          label={t('baseDn')}
          placeholder="ou=people,dc=example,dc=org"
          defaultValue={v?.baseDn}
        />
        <FormField
          name="userFilter"
          label={t('userFilter')}
          hint={t('userFilterHint')}
          defaultValue={v?.userFilter ?? '(&(objectClass=person)(uid={login}))'}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            name="loginAttribute"
            label={t('loginAttribute')}
            hint={t('loginAttributeHint')}
            defaultValue={v?.loginAttribute ?? 'uid'}
          />
          <FormField
            name="idAttribute"
            label={t('idAttribute')}
            hint={t('idAttributeHint')}
            defaultValue={v?.idAttribute ?? 'entryUUID'}
          />
        </div>
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-2 font-semibold">{t('mapping')}</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField name="mapEmail" label={t('mapEmail')} defaultValue={m.email ?? 'mail'} />
          <FormField
            name="mapFirstName"
            label={t('mapFirstName')}
            defaultValue={m.firstName ?? 'givenName'}
          />
          <FormField
            name="mapLastName"
            label={t('mapLastName')}
            defaultValue={m.lastName ?? 'sn'}
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
      <fieldset className="grid gap-3">
        <legend className="mb-2 font-semibold">{t('accounts')}</legend>
        <Toggle name="linkByEmail" label={t('linkByEmail')} checked={v?.linkByEmail ?? true} />
        <Toggle name="autoCreate" label={t('autoCreate')} checked={v?.autoCreate ?? false} />
        <Toggle
          name="suspendMissing"
          label={t('suspendMissing')}
          checked={v?.suspendMissing ?? false}
        />
      </fieldset>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** Checking the connection with one login, and a sync on demand. */
export function LdapTools({ lastSync }: { lastSync: string }) {
  const t = useTranslations('adminLdap');
  const [pending, start] = useTransition();
  const [login, setLogin] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('check')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-0 flex-1 gap-1">
            <label htmlFor="ldap-test-login" className="text-sm font-medium">
              {t('testLogin')}
            </label>
            <Input
              id="ldap-test-login"
              value={login}
              onChange={(e) => setLogin(e.currentTarget.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await testLdapAction(login);
                if (!r.ok) return void toast.error(r.message);
                const d = r.data;
                setResult(
                  !d.ok
                    ? { ok: false, text: t('testFailed', { error: d.error }) }
                    : d.person
                      ? {
                          ok: true,
                          text: t('testFound', {
                            name: `${d.person.firstName} ${d.person.lastName}`.trim(),
                            email: d.person.email || '—',
                            dn: d.person.dn,
                          }),
                        }
                      : { ok: true, text: login ? t('testNotFound') : t('testConnected') },
                );
              })
            }
          >
            {t('test')}
          </Button>
        </div>
        {result ? (
          <Alert variant={result.ok ? 'success' : 'destructive'} className="break-words">
            {result.text}
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await syncLdapAction();
                if (r.ok) toast.success(t('syncQueued'));
                else toast.error(r.message);
              })
            }
          >
            {t('syncNow')}
          </Button>
          <p className="text-sm text-muted-foreground">{lastSync}</p>
        </div>
      </CardContent>
    </Card>
  );
}
