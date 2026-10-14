import { courseFieldLabel, editingLanguages, listCourseFields } from '@hubium/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { CourseFieldCommands, CourseFieldForm } from './forms';

export const generateMetadata = titled('courseFields', 'title');

export default async function CourseFieldsPage() {
  await requireCapability('site:config');
  const [t, tp, fields, locale] = await Promise.all([
    getTranslations('courseFields'),
    getTranslations('profileFields'),
    listCourseFields(db),
    getLocale(),
  ]);
  const languages = await Promise.all(fields.map((f) => editingLanguages(db, f.name)));
  const newLanguages = await editingLanguages(db);
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      {fields.length ? null : <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {fields.map((f, i) => (
        <Card key={f.id}>
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            <CardTitle className="mr-auto">{courseFieldLabel(f, locale)}</CardTitle>
            <Badge>{f.shortName}</Badge>
            <Badge variant="neutral">{tp(`types.${f.type}`)}</Badge>
            {f.required ? <Badge variant="warning">{tp('required')}</Badge> : null}
            {f.visible ? null : <Badge variant="neutral">{t('hidden')}</Badge>}
            <CourseFieldCommands
              id={f.id}
              name={courseFieldLabel(f, locale)}
              first={i === 0}
              last={i === fields.length - 1}
            />
          </CardHeader>
          <CardContent>
            <CourseFieldForm field={f} languages={languages[i]!} />
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>{tp('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CourseFieldForm languages={newLanguages} />
        </CardContent>
      </Card>
    </div>
  );
}
