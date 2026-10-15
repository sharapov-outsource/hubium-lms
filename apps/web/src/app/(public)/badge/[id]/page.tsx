import {
  badgeOrigin,
  badgeUrls,
  criteriaNarrative,
  getAllSettings,
  publicAward,
} from '@hubium/core';
import { Badge, Card, CardContent } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { BadgeImage } from '@/components/badges/badge-image';
import { db } from '@/server/db';
import { getCurrentUser } from '@/server/session';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = /^[0-9a-f-]{36}$/.test(id) ? await publicAward(db, id) : null;
  return { title: a?.badge.name ?? (await getTranslations('badges'))('title') };
}

/** An awarded badge as anyone sees it: whose, from whom, valid or not, and how to check it. */
export default async function BadgeAwardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = /^[0-9a-f-]{36}$/.test(id) ? await publicAward(db, id) : null;
  if (!a || a.badge.status === 'DRAFT') notFound();
  const [t, format, settings, me] = await Promise.all([
    getTranslations('badges'),
    getFormatter(),
    getAllSettings(db),
    getCurrentUser().catch(() => null),
  ]);
  const urls = badgeUrls(badgeOrigin());
  const expired = !!a.expiresAt && a.expiresAt < new Date();
  const narrative = await criteriaNarrative(db, a.badge, await getLocale());
  const date = (d: Date) => format.dateTime(d, { dateStyle: 'long' });
  return (
    <Card>
      <CardContent className="grid gap-5 pt-6 sm:grid-cols-[10rem_1fr]">
        <BadgeImage badgeId={a.badgeId} name={a.badge.name} className="mx-auto" />
        <div className="grid content-start gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{a.badge.name}</h1>
            {a.badge.description ? (
              <p className="mt-1 whitespace-pre-line text-muted-foreground">
                {a.badge.description}
              </p>
            ) : null}
          </div>
          <div>
            {a.revokedAt ? (
              <Badge variant="destructive">{t('revoked')}</Badge>
            ) : expired ? (
              <Badge variant="warning">{t('expired')}</Badge>
            ) : (
              <Badge variant="success">{t('valid')}</Badge>
            )}
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('recipient')}</dt>
            <dd>{a.user.name}</dd>
            <dt className="text-muted-foreground">{t('issuer')}</dt>
            <dd>
              {settings['badges.issuerName'] || settings['site.name']}
              {a.badge.course ? ` · ${a.badge.course.fullName}` : ''}
            </dd>
            <dt className="text-muted-foreground">{t('issuedOn')}</dt>
            <dd>{date(a.issuedAt)}</dd>
            <dt className="text-muted-foreground">{t('expires')}</dt>
            <dd>{a.expiresAt ? date(a.expiresAt) : t('never')}</dd>
            {a.revokedAt ? (
              <>
                <dt className="text-muted-foreground">{t('revokedOn')}</dt>
                <dd>
                  {date(a.revokedAt)}
                  {a.revokedReason ? `: ${a.revokedReason}` : ''}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('criteria')}</dt>
            <dd>{narrative}</dd>
          </dl>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <a href={urls.assertion(a.id)} className="text-accent hover:underline">
              {t('verify')}
            </a>
            {me?.id === a.userId && !a.revokedAt ? (
              <a href={urls.baked(a.id)} download className="text-accent hover:underline">
                {t('download')}
              </a>
            ) : null}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
