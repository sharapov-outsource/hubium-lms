import { badgeOrigin, badgeUrls, userBadges } from '@hubium/core';
import { Badge, Card, CardContent, EmptyState, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { BadgeImage } from '@/components/badges/badge-image';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireUser } from '@/server/session';

export const generateMetadata = titled('badges', 'myTitle');

/** The badges a person has earned, each with its public page and baked image. */
export default async function MyBadgesPage() {
  const me = await requireUser();
  const [awards, t, format] = await Promise.all([
    userBadges(db, me.id),
    getTranslations('badges'),
    getFormatter(),
  ]);
  const urls = badgeUrls(badgeOrigin());
  const date = (d: Date) => format.dateTime(d, { dateStyle: 'medium' });
  const now = new Date();
  return (
    <>
      <PageHeader title={t('myTitle')} description={t('myIntro')} />
      {awards.length === 0 ? <EmptyState title={t('myEmpty')} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {awards.map((a) => (
          <Card key={a.id}>
            <CardContent className="flex items-start gap-4 pt-6">
              <BadgeImage badgeId={a.badgeId} name={a.badge.name} size={16} />
              <div className="grid min-w-0 gap-1 text-sm">
                <Link href={`/badge/${a.id}`} className="font-semibold hover:underline">
                  {a.badge.name}
                </Link>
                <span className="text-muted-foreground">
                  {a.badge.course ? a.badge.course.fullName : t('siteBadge')}
                </span>
                <span>{t('earnedOn', { date: date(a.issuedAt) })}</span>
                {a.expiresAt ? (
                  <span className="text-muted-foreground">
                    {t('expires')}: {date(a.expiresAt)}
                  </span>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {a.revokedAt ? (
                    <Badge variant="destructive">{t('revoked')}</Badge>
                  ) : a.expiresAt && a.expiresAt < now ? (
                    <Badge variant="warning">{t('expired')}</Badge>
                  ) : (
                    <a href={urls.baked(a.id)} download className="text-accent hover:underline">
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
