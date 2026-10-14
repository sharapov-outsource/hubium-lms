import { getLdapServer, type LdapMapping } from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { LdapForm, LdapTools } from './ldap-form';

export const generateMetadata = titled('adminLdap', 'title');

export default async function LdapPage() {
  await requireCapability('site:config');
  const [t, format, fields, s] = await Promise.all([
    getTranslations('adminLdap'),
    getFormatter(),
    getLocale().then((l) => profileFieldViews(l)),
    getLdapServer(db),
  ]);
  const last = s?.lastSyncResult as
    | { checked: number; updated: number; suspended: number; errors: number }
    | null
    | undefined;
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <LdapForm
        profileFields={fields.map((f) => ({ shortName: f.shortName, label: f.label }))}
        values={
          s
            ? {
                enabled: s.enabled,
                url: s.url,
                startTls: s.startTls,
                caCertificate: s.caCertificate ?? '',
                bindDn: s.bindDn,
                hasPassword: !!s.bindPasswordEnc,
                baseDn: s.baseDn,
                userFilter: s.userFilter,
                loginAttribute: s.loginAttribute,
                idAttribute: s.idAttribute,
                mapping: s.mapping as LdapMapping,
                autoCreate: s.autoCreate,
                linkByEmail: s.linkByEmail,
                suspendMissing: s.suspendMissing,
              }
            : undefined
        }
      />
      {s ? (
        <LdapTools
          lastSync={
            s.lastSyncAt && last
              ? t('lastSync', {
                  when: format.dateTime(s.lastSyncAt, { dateStyle: 'medium', timeStyle: 'short' }),
                  checked: last.checked,
                  updated: last.updated,
                  suspended: last.suspended,
                  errors: last.errors,
                })
              : t('neverSynced')
          }
        />
      ) : null}
    </div>
  );
}
