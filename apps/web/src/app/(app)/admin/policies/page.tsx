import { editingLanguages, listPolicies, pickLocalized } from '@hubium/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { PolicyForm, PublishForm } from './forms';

export const generateMetadata = titled('adminPolicies', 'title');

export default async function AdminPoliciesPage() {
  await requireCapability('site:config');
  const [t, format, policies, locale, newLanguages] = await Promise.all([
    getTranslations('adminPolicies'),
    getFormatter(),
    listPolicies(db),
    getLocale(),
    editingLanguages(db),
  ]);
  const languages = await Promise.all(
    policies.map((p) =>
      editingLanguages(db, { ...(p.name as object), ...((p.current?.content ?? {}) as object) }),
    ),
  );
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {policies.map((p, i) => {
        const name = p.name as Record<string, string>;
        const content = (p.current?.content ?? {}) as Record<string, string>;
        return (
          <Card key={p.id}>
            <CardHeader className="flex-row flex-wrap items-center gap-2">
              <CardTitle className="mr-auto">{pickLocalized(name, locale) || p.key}</CardTitle>
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
              <PolicyForm policy={{ id: p.id, key: p.key, name }} languages={languages[i]!} />
              <PublishForm policyId={p.id} content={content} languages={languages[i]!} />
            </CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <PolicyForm languages={newLanguages} />
        </CardContent>
      </Card>
    </div>
  );
}
