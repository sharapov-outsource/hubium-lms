import { listProfileFields } from '@hubium/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { FieldCommands, ProfileFieldForm } from './forms';

export const generateMetadata = titled('profileFields', 'title');

export default async function ProfileFieldsPage() {
  await requireCapability('site:config');
  const [t, fields] = await Promise.all([getTranslations('profileFields'), listProfileFields(db)]);
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {fields.length ? null : <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {fields.map((f, i) => (
        <Card key={f.id}>
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            <CardTitle className="mr-auto">{f.name.ru}</CardTitle>
            <Badge>{f.shortName}</Badge>
            <Badge variant="neutral">{t(`types.${f.type}`)}</Badge>
            {f.required ? <Badge variant="warning">{t('required')}</Badge> : null}
            <FieldCommands
              id={f.id}
              name={f.name.ru}
              first={i === 0}
              last={i === fields.length - 1}
            />
          </CardHeader>
          <CardContent>
            <ProfileFieldForm field={f} />
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>{t('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ProfileFieldForm />
        </CardContent>
      </Card>
    </div>
  );
}
