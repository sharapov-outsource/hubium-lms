import { listSsoProviders, type SsoMapping } from '@hubium/core';
import { Alert, Card, CardContent, PageHeader } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { deleteSsoProviderAction } from '@/server/actions/sso';
import { profileFieldViews } from '@/server/profile-fields';
import { requireCapability } from '@/server/session';
import { SsoForm } from '../sso-form';

export async function generateMetadata() {
  return { title: (await getTranslations('adminSso'))('title') };
}

export default async function SsoProviderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { ctx } = await requireCapability('site:config');
  const [{ id }, sp, t, fields, providers] = await Promise.all([
    params,
    searchParams,
    getTranslations('adminSso'),
    getLocale().then((l) => profileFieldViews(l)),
    listSsoProviders(ctx),
  ]);
  const p = providers.find((x) => x.id === id);
  if (!p) notFound();
  const oidc = p.oidcConfig
    ? (JSON.parse(p.oidcConfig) as { clientId?: string; scopes?: string[] })
    : {};
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  return (
    <>
      <PageHeader title={p.name} />
      {sp.saved ? (
        <Alert variant="success" className="mb-6">
          {t('saved')}
        </Alert>
      ) : null}
      <div className="grid gap-6">
        <SsoForm
          appUrl={appUrl}
          profileFields={fields.map((f) => ({ shortName: f.shortName, label: f.label }))}
          values={{
            id: p.id,
            providerId: p.providerId,
            name: p.name,
            protocol: p.protocol === 'saml' ? 'saml' : 'oidc',
            enabled: p.enabled,
            autoCreate: p.autoCreate,
            linkByEmail: p.linkByEmail,
            domain: p.domain,
            issuer: p.protocol === 'oidc' ? p.issuer : undefined,
            clientId: oidc.clientId,
            hasSecret: p.hasSecret,
            scopes: oidc.scopes?.join(' '),
            mapping: p.mapping as SsoMapping,
          }}
        />
        <Card className="max-w-2xl">
          <CardContent className="flex flex-wrap items-center gap-3 pt-5">
            {p.protocol === 'saml' ? (
              <a
                href={`${appUrl}/api/auth/sso/saml2/sp/metadata?providerId=${p.providerId}`}
                className="text-sm text-accent hover:underline"
              >
                {t('spMetadata')}
              </a>
            ) : null}
            <CommandButton
              size="sm"
              variant="destructive"
              confirm={t('deleteConfirm', { name: p.name })}
              run={deleteSsoProviderAction.bind(null, p.id)}
            >
              {t('delete')}
            </CommandButton>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
