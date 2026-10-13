import { listPolicies } from '@hubium/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { PolicyForm, PublishForm } from './forms';

export const generateMetadata = titled('adminPolicies', 'title');

export default async function AdminPoliciesPage() {
  await requireCapability('site:config');
  const [t, format, policies] = await Promise.all([
    getTranslations('adminPolicies'),
    getFormatter(),
    listPolicies(db),
  ]);
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {policies.map((p) => {
        const name = p.name as { ru: string; en: string };
        const content = (p.current?.content ?? { ru: '', en: '' }) as { ru: string; en: string };
        return (
          <Card key={p.id}>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="mr-auto">{name.ru}</CardTitle>
              <Badge>{p.key}</Badge>
              {p.current ? (
                <Badge variant={p.current.mandatory ? 'warning' : 'neutral'}>
                  {t('published', {
                    date: format.dateTime(p.current.publishedAt!, { dateStyle: 'medium' }),
                    n: p.current._count.acceptances,
                  })}
                </Badge>
              ) : (
                <Badge variant="neutral">{t('draft')}</Badge>
              )}
            </CardHeader>
            <CardContent className="grid gap-6">
              <PolicyForm policy={{ id: p.id, key: p.key, nameRu: name.ru, nameEn: name.en }} />
              <PublishForm policyId={p.id} content={content} />
            </CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PolicyForm />
        </CardContent>
      </Card>
    </div>
  );
}
