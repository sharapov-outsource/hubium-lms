import { listApiTokens } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { forbidden } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { revokeApiTokenAction } from '@/server/actions/tokens';
import { getContext, requireUser } from '@/server/session';
import { NewTokenForm } from './new-token';

export default async function ApiTokensPage() {
  await requireUser();
  const ctx = await getContext();
  if (!(await ctx.perm.can('webservice:createtoken'))) forbidden();
  const [t, format, tokens] = await Promise.all([
    getTranslations('apiTokens'),
    getFormatter(),
    listApiTokens(ctx),
  ]);
  const date = (d: Date | null) => (d ? format.dateTime(d, { dateStyle: 'medium' }) : '—');
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t.rich('hint', {
              docs: (chunks) => (
                <a href="/api/v1/docs" className="text-accent underline">
                  {chunks}
                </a>
              ),
            })}
          </p>
          <NewTokenForm />
        </CardContent>
      </Card>
      {tokens.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <Table>
          <THead>
            <Tr>
              <Th>{t('name')}</Th>
              <Th>{t('scopes')}</Th>
              <Th>{t('expires')}</Th>
              <Th>{t('lastUsed')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {tokens.map((tok) => (
              <Tr key={tok.id}>
                <Td>
                  <span className="font-medium">{tok.name}</span>
                  <p className="font-mono text-xs text-muted-foreground">hub_{tok.prefix}…</p>
                </Td>
                <Td>{tok.scopes.join(', ')}</Td>
                <Td>{tok.expiresAt ? date(tok.expiresAt) : t('never')}</Td>
                <Td>{date(tok.lastUsedAt)}</Td>
                <Td className="text-right">
                  {tok.revokedAt ? (
                    <Badge variant="neutral">{t('revoked')}</Badge>
                  ) : (
                    <CommandButton
                      size="sm"
                      variant="ghost"
                      confirm={t('revokeConfirm')}
                      run={revokeApiTokenAction.bind(null, tok.id)}
                    >
                      {t('revoke')}
                    </CommandButton>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
