import { listWebhooks } from '@hubium/core';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { WebhookForm } from './webhook-form';

export const generateMetadata = titled('adminWebhooks', 'title');

export default async function WebhooksPage() {
  const { ctx } = await requireCapability('site:config');
  const [t, format, hooks] = await Promise.all([
    getTranslations('adminWebhooks'),
    getFormatter(),
    listWebhooks(ctx),
  ]);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {hooks.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('name')}</Th>
              <Th>{t('url')}</Th>
              <Th className="w-28">{t('eventsCount')}</Th>
              <Th className="w-36">{t('status')}</Th>
              <Th className="w-44">{t('lastDelivery')}</Th>
            </Tr>
          </THead>
          <TBody>
            {hooks.map((w) => (
              <Tr key={w.id}>
                <Td>
                  <Link
                    href={`/admin/webhooks/${w.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {w.name}
                  </Link>
                </Td>
                <Td className="max-w-72 truncate font-mono text-xs" title={w.url}>
                  {w.url}
                </Td>
                <Td className="tabular-nums">{w.events.length}</Td>
                <Td>
                  <Badge variant={w.enabled ? 'success' : 'warning'}>
                    {w.enabled ? t('on') : t('off')}
                  </Badge>
                </Td>
                <Td className="text-sm text-muted-foreground">
                  {w.lastDeliveryAt
                    ? format.dateTime(w.lastDeliveryAt, { dateStyle: 'medium', timeStyle: 'short' })
                    : '—'}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
          <CardDescription>{t('newHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookForm />
        </CardContent>
      </Card>
    </div>
  );
}
