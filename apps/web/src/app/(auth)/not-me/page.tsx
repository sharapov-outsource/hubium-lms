import { notMeDetails } from '@hubium/core';
import { Alert, Button, Card, CardContent, CardHeader } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { reportNotMeAction } from './action';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return { title: (await getTranslations('auth'))('notMe.title') };
}

/** Opened from the "new sign-in" notice; works without signing in. */
export default async function NotMePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; invalid?: string }>;
}) {
  const [sp, t, format] = await Promise.all([
    searchParams,
    getTranslations('auth'),
    getFormatter(),
  ]);
  const device = sp.token && !sp.done ? await notMeDetails(db, sp.token) : null;
  return (
    <Card>
      <CardHeader>
        <h1 className="text-lg font-semibold">{t('notMe.title')}</h1>
      </CardHeader>
      <CardContent className="grid gap-4">
        {sp.done ? (
          <Alert variant="success">
            {sp.done === 'reset' ? t('notMe.doneReset') : t('notMe.doneSessions')}
          </Alert>
        ) : !device ? (
          <Alert variant="destructive">{t('notMe.invalid')}</Alert>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('notMe.device')}</dt>
              <dd>{device.label}</dd>
              <dt className="text-muted-foreground">{t('notMe.ip')}</dt>
              <dd className="break-all">{device.lastIp ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('notMe.time')}</dt>
              <dd>
                {format.dateTime(device.firstSeenAt, { dateStyle: 'medium', timeStyle: 'short' })}
              </dd>
            </dl>
            <p className="text-sm text-muted-foreground">{t('notMe.intro')}</p>
            {/* A button, not an automatic GET: mail scanners follow links. */}
            <form action={reportNotMeAction.bind(null, sp.token!)}>
              <Button type="submit" variant="destructive">
                {t('notMe.action')}
              </Button>
            </form>
            <Link href="/dashboard" className="text-sm text-accent hover:underline">
              {t('notMe.itWasMe')}
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
