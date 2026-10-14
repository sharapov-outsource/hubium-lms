import { Alert, Button, Card, CardContent, CardHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { unlockAccountAction } from './action';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return { title: (await getTranslations('auth'))('unlock.title') };
}

export default async function UnlockAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; done?: string; invalid?: string }>;
}) {
  const [sp, t] = await Promise.all([searchParams, getTranslations('auth')]);
  return (
    <Card>
      <CardHeader>
        <h1 className="text-lg font-semibold">{t('unlock.title')}</h1>
      </CardHeader>
      <CardContent className="grid gap-4">
        {sp.done ? (
          <Alert variant="success">{t('unlock.done')}</Alert>
        ) : sp.invalid || !sp.token ? (
          <Alert variant="destructive">{t('unlock.invalid')}</Alert>
        ) : (
          // A button, not an automatic GET: mail scanners follow links.
          <form action={unlockAccountAction.bind(null, sp.token)} className="grid gap-3">
            <p className="text-sm text-muted-foreground">{t('unlock.intro')}</p>
            <Button type="submit">{t('unlock.action')}</Button>
          </form>
        )}
        <Link href="/login" className="text-sm text-accent hover:underline">
          {t('backToSignIn')}
        </Link>
      </CardContent>
    </Card>
  );
}
