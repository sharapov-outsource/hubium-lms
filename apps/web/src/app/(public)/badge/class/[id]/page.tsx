import { criteriaNarrative, getAllSettings } from '@hubium/core';
import { Card, CardContent } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { BadgeImage } from '@/components/badges/badge-image';
import { db } from '@/server/db';

async function load(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const b = await db.badge.findUnique({
    where: { id },
    include: { course: { select: { fullName: true } } },
  });
  return b && b.status !== 'DRAFT' ? b : null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const b = await load((await params).id);
  return { title: b?.name ?? (await getTranslations('badges'))('title') };
}

/** What a badge is and what earns it: the criteria page its badge class points to. */
export default async function BadgeClassPage({ params }: { params: Promise<{ id: string }> }) {
  const b = await load((await params).id);
  if (!b) notFound();
  const [t, settings, locale] = await Promise.all([
    getTranslations('badges'),
    getAllSettings(db),
    getLocale(),
  ]);
  return (
    <Card>
      <CardContent className="grid gap-5 pt-6 sm:grid-cols-[10rem_1fr]">
        <BadgeImage badgeId={b.id} name={b.name} className="mx-auto" />
        <div className="grid content-start gap-3">
          <h1 className="text-2xl font-semibold">{b.name}</h1>
          {b.description ? (
            <p className="whitespace-pre-line text-muted-foreground">{b.description}</p>
          ) : null}
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('issuer')}</dt>
            <dd>
              {settings['badges.issuerName'] || settings['site.name']}
              {b.course ? ` · ${b.course.fullName}` : ''}
            </dd>
            <dt className="text-muted-foreground">{t('criteria')}</dt>
            <dd>{await criteriaNarrative(db, b, locale)}</dd>
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}
