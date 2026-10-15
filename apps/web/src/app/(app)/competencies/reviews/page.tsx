import { reviewQueue } from '@hubium/core';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { StatusBadge } from '@/components/competencies/shared';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';

export const generateMetadata = titled('competencies', 'reviews');

/** Plans and competencies people asked to have reviewed, and those the viewer is reviewing. */
export default async function ReviewsPage() {
  const { ctx } = await requireCapability('competency:review');
  const [t, q] = await Promise.all([getTranslations('competencies'), reviewQueue(ctx)]);
  return (
    <>
      <PageHeader title={t('reviews')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('plansTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {q.plans.length ? (
              q.plans.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/plans/${p.id}`} className="hover:underline">
                    {p.user.name}: {p.name}
                  </Link>
                  <StatusBadge status={p.status} />
                </div>
              ))
            ) : (
              <span className="text-muted-foreground">{t('nothingToReview')}</span>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('competenciesTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {q.competencies.length ? (
              q.competencies.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/competencies/user/${c.userId}/${c.competencyId}`}
                    className="hover:underline"
                  >
                    {c.user.name}: {c.competency.shortName}
                  </Link>
                  <StatusBadge status={c.status} />
                </div>
              ))
            ) : (
              <span className="text-muted-foreground">{t('nothingToReview')}</span>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
