import { listSsoProviders } from '@hubium/core';
import { Alert, Badge, Button, PageHeader, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('adminSso', 'title');

export default async function SsoProvidersPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const { ctx } = await requireCapability('site:config');
  const [t, sp, providers] = await Promise.all([
    getTranslations('adminSso'),
    searchParams,
    listSsoProviders(ctx),
  ]);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        className="mb-0"
        actions={
          <Button asChild>
            <Link href="/admin/sso/new">
              <Plus />
              {t('new')}
            </Link>
          </Button>
        }
      />
      {sp.deleted ? <Alert variant="success">{t('deleted')}</Alert> : null}
      {providers.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('name')}</Th>
              <Th className="w-36">{t('protocol')}</Th>
              <Th>{t('providerId')}</Th>
              <Th className="w-36">{t('status')}</Th>
            </Tr>
          </THead>
          <TBody>
            {providers.map((p) => (
              <Tr key={p.id}>
                <Td>
                  <Link
                    href={`/admin/sso/${p.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {p.name}
                  </Link>
                </Td>
                <Td>
                  {p.protocol === 'saml'
                    ? 'SAML 2.0'
                    : p.protocol === 'oauth2'
                      ? 'OAuth 2'
                      : 'OpenID Connect'}
                </Td>
                <Td className="font-mono text-xs">{p.providerId}</Td>
                <Td>
                  <Badge variant={p.enabled ? 'success' : 'warning'}>
                    {p.enabled ? t('on') : t('off')}
                  </Badge>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
    </div>
  );
}
