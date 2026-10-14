import { listMentees } from '@hubium/core';
import { Badge, Card, CardContent, EmptyState, PageHeader } from '@hubium/ui';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getContext, requireUser } from '@/server/session';

export async function generateMetadata() {
  return { title: (await getTranslations('mentees'))('title') };
}

export default async function MenteesPage() {
  await requireUser();
  const [t, format, mentees] = await Promise.all([
    getTranslations('mentees'),
    getFormatter(),
    listMentees(await getContext()),
  ]);
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {mentees.length ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {mentees.map((m) => (
            <li key={m.id}>
              <Card className="h-full">
                <CardContent className="grid gap-2 pt-5">
                  <Link href={`/mentees/${m.id}`} className="text-lg font-semibold hover:underline">
                    {m.name}
                  </Link>
                  <Badge className="w-fit">{t(m.kind === 'PARENT' ? 'parent' : 'mentor')}</Badge>
                  <p className="text-sm text-muted-foreground">
                    {m.lastAccessAt
                      ? t('lastVisit', { time: format.relativeTime(m.lastAccessAt) })
                      : t('neverVisited')}
                  </p>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Users />} title={t('empty')} />
      )}
    </>
  );
}
