import { userCertificates } from '@hubium/core';
import { Badge, Card, CardContent, EmptyState, PageHeader } from '@hubium/ui';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireUser } from '@/server/session';

export const generateMetadata = titled('certificates', 'myTitle');

/** The certificates a person has been issued, to download and to share by code. */
export default async function MyCertificatesPage() {
  const me = await requireUser();
  const [issues, t, format] = await Promise.all([
    userCertificates(db, me.id),
    getTranslations('certificates'),
    getFormatter(),
  ]);
  return (
    <>
      <PageHeader title={t('myTitle')} description={t('myIntro')} />
      {issues.length === 0 ? <EmptyState title={t('myEmpty')} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {issues.map((i) => (
          <Card key={i.id}>
            <CardContent className="flex items-start gap-4 pt-6">
              <FileText className="size-8 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid min-w-0 gap-1 text-sm">
                <span className="font-semibold">{i.certificate.name}</span>
                <Link
                  href={`/course/${i.certificate.course.id}`}
                  className="text-muted-foreground hover:underline"
                >
                  {i.certificate.course.fullName}
                </Link>
                <span>
                  {t('issuedOn', { date: format.dateTime(i.issuedAt, { dateStyle: 'medium' }) })}
                </span>
                <span>
                  {t('code')}:{' '}
                  <Link href={`/verify/${i.code}`} className="font-mono hover:underline">
                    {i.code}
                  </Link>
                </span>
                <div>
                  {i.revokedAt ? (
                    <Badge variant="destructive">{t('revoked')}</Badge>
                  ) : (
                    <a
                      href={`/api/certificates/issues/${i.id}/pdf`}
                      className="text-accent hover:underline"
                    >
                      {t('download')}
                    </a>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
