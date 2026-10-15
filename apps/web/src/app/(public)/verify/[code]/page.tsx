import { getAllSettings, verifyCertificate } from '@hubium/core';
import { Badge, Button, Card, CardContent } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';

export async function generateMetadata() {
  return { title: (await getTranslations('certificates'))('verifyTitle') };
}

/** What a certificate with this code says, and whether it still stands. */
export default async function VerifyCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const [found, t, format, settings] = await Promise.all([
    verifyCertificate(db, decodeURIComponent(code)),
    getTranslations('certificates'),
    getFormatter(),
    getAllSettings(db),
  ]);
  const date = (d: Date) => format.dateTime(d, { dateStyle: 'long' });
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <h1 className="text-2xl font-semibold">{t('verifyTitle')}</h1>
        {found ? (
          <>
            <div>
              {found.revokedAt ? (
                <Badge variant="destructive">{t('revoked')}</Badge>
              ) : (
                <Badge variant="success">{t('valid')}</Badge>
              )}
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">{t('code')}</dt>
              <dd className="font-mono">{found.code}</dd>
              <dt className="text-muted-foreground">{t('recipient')}</dt>
              <dd>{found.name}</dd>
              <dt className="text-muted-foreground">{t('certificate')}</dt>
              <dd>{found.certificate}</dd>
              <dt className="text-muted-foreground">{t('course')}</dt>
              <dd>{found.course}</dd>
              <dt className="text-muted-foreground">{t('issuer')}</dt>
              <dd>{settings['site.name']}</dd>
              {found.completedAt ? (
                <>
                  <dt className="text-muted-foreground">{t('completedOn')}</dt>
                  <dd>{date(found.completedAt)}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t('issued')}</dt>
              <dd>{date(found.issuedAt)}</dd>
              {found.revokedAt ? (
                <>
                  <dt className="text-muted-foreground">{t('revokedOn')}</dt>
                  <dd>
                    {date(found.revokedAt)}
                    {found.revokedReason ? `: ${found.revokedReason}` : ''}
                  </dd>
                </>
              ) : null}
            </dl>
          </>
        ) : (
          <p role="alert" className="text-sm">
            {t('notFound')}
          </p>
        )}
        <div>
          <Button asChild variant="secondary">
            <Link href="/verify">{t('verifyAnother')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
