import { parseUnsubscribeToken } from '@hubium/core';
import { Alert, Button, Card, CardContent, CardHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { unsubscribeAction } from './action';

export const dynamic = 'force-dynamic';

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const [{ token }, sp, t, tAll] = await Promise.all([
    params,
    searchParams,
    getTranslations('notifications'),
    getTranslations(),
  ]);
  const parsed = parseUnsubscribeToken(token);
  return (
    <Card>
      <CardHeader>
        <h1 className="text-lg font-semibold">{t('unsubscribe.title')}</h1>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!parsed ? (
          <Alert variant="destructive">{t('unsubscribe.invalid')}</Alert>
        ) : sp.done ? (
          <Alert variant="success">
            {parsed.type === '*' ? t('unsubscribe.doneAll') : t('unsubscribe.done')}
          </Alert>
        ) : (
          // A button, not an automatic GET: mail scanners follow links.
          <form action={unsubscribeAction.bind(null, token)} className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              {parsed.type === '*'
                ? t('email.unsubscribeAll')
                : tAll.has(`notifications.types.${parsed.type.replace('.', '_')}`)
                  ? tAll(`notifications.types.${parsed.type.replace('.', '_')}`)
                  : t('email.unsubscribe')}
            </p>
            <Button type="submit">{t('email.unsubscribe')}</Button>
          </form>
        )}
        <Link href="/settings/notifications" className="text-sm text-accent hover:underline">
          {t('unsubscribe.manage')}
        </Link>
      </CardContent>
    </Card>
  );
}
