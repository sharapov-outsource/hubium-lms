import { getWebhook, listWebhookDeliveries } from '@hubium/core';
import {
  Alert,
  Badge,
  Button,
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
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CommandButton } from '@/components/confirm-button';
import { Pagination } from '@/components/pagination';
import { pageParam } from '@/lib/url-params';
import {
  deleteWebhookAction,
  pingWebhookAction,
  redeliverWebhookAction,
} from '@/server/actions/webhooks';
import { viewerCan } from '@/server/page-title';
import { getContext, requireCapability } from '@/server/session';
import { WebhookForm } from '../webhook-form';
import { RotateSecretButton } from './secret-button';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f-]{36}$/;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id) || !(await viewerCan('site:config'))) return {};
  const w = await getWebhook(await getContext(), id).catch(() => null);
  return w ? { title: w.name } : {};
}

const statusVariant = { SUCCESS: 'success', FAILED: 'destructive', PENDING: 'neutral' } as const;

export default async function WebhookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { ctx } = await requireCapability('site:config');
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const w = await getWebhook(ctx, id).catch(() => notFound());
  const page = pageParam(sp.page);
  const [t, format, log] = await Promise.all([
    getTranslations('adminWebhooks'),
    getFormatter(),
    listWebhookDeliveries(ctx, id, { page, pageSize: PAGE_SIZE }),
  ]);
  const eventName = (e: string) =>
    e === 'ping' ? t('pingEvent') : t(`eventNames.${e.replace(/\./g, '_')}` as never);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader
        title={w.name}
        description={<span className="break-all font-mono text-xs">{w.url}</span>}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/webhooks">← {t('title')}</Link>
          </Button>
        }
        className="mb-0"
      />
      {!w.enabled ? (
        <Alert variant="warning">
          {w.disabledReason ? t('disabledBecause', { reason: w.disabledReason }) : t('disabled')}
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings')}</CardTitle>
        </CardHeader>
        <CardContent>
          <WebhookForm
            webhook={{ id: w.id, name: w.name, url: w.url, events: w.events, enabled: w.enabled }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('actions')}</CardTitle>
          <CardDescription>{t('actionsHint')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <CommandButton
            size="sm"
            variant="outline"
            run={pingWebhookAction.bind(null, w.id)}
            success={t('pinged')}
          >
            {t('ping')}
          </CommandButton>
          <CommandButton
            size="sm"
            variant="destructive"
            confirm={t('deleteConfirm', { name: w.name })}
            run={deleteWebhookAction.bind(null, w.id)}
          >
            {t('delete')}
          </CommandButton>
          <RotateSecretButton id={w.id} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('deliveries')}</CardTitle>
          <CardDescription>{t('deliveriesHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {log.items.length ? (
            <Table>
              <THead>
                <Tr>
                  <Th className="w-44">{t('time')}</Th>
                  <Th>{t('event')}</Th>
                  <Th className="w-32">{t('status')}</Th>
                  <Th className="w-24">{t('attempts')}</Th>
                  <Th>{t('response')}</Th>
                  <Th className="w-32">
                    <span className="sr-only">{t('actions')}</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {log.items.map((d) => (
                  <Tr key={d.id}>
                    <Td className="text-sm tabular-nums">
                      {format.dateTime(d.createdAt, { dateStyle: 'short', timeStyle: 'medium' })}
                    </Td>
                    <Td className="text-sm">
                      {eventName(d.event)}
                      <code className="block text-xs text-muted-foreground">{d.event}</code>
                    </Td>
                    <Td>
                      <Badge variant={statusVariant[d.status]}>{t(`statuses.${d.status}`)}</Badge>
                    </Td>
                    <Td className="tabular-nums">{d.attempts}</Td>
                    <Td className="max-w-72 text-xs">
                      {d.responseStatus ? (
                        <span className="font-mono">HTTP {d.responseStatus}</span>
                      ) : d.responseBody ? (
                        // No HTTP answer: the network error itself.
                        <span className="text-destructive">{d.responseBody}</span>
                      ) : null}
                      {d.responseStatus && d.responseBody ? (
                        <details>
                          <summary className="cursor-pointer text-muted-foreground">
                            {t('answer')}
                          </summary>
                          <pre className="scrollbar-hairline mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">
                            {d.responseBody}
                          </pre>
                        </details>
                      ) : null}
                    </Td>
                    <Td>
                      {d.status !== 'PENDING' ? (
                        <CommandButton
                          size="sm"
                          variant="ghost"
                          run={redeliverWebhookAction.bind(null, d.id, w.id)}
                          success={t('redelivered')}
                        >
                          {t('redeliver')}
                        </CommandButton>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">{t('noDeliveries')}</p>
          )}
          <Pagination page={log.page} pageSize={log.pageSize} total={log.total} />
        </CardContent>
      </Card>
    </div>
  );
}
