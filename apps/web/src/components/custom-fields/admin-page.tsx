import {
  courseFieldLabel,
  editingLanguages,
  listCourseFields,
  listProfileFields,
  profileFieldLabel,
} from '@hubium/core';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { FieldCommands, FieldForm, type FieldKind } from './forms';

/** The admin page of the site's own course or profile fields: one card per field, then a new one. */
export async function CustomFieldsAdmin({ kind }: { kind: FieldKind }) {
  const [tp, tcf, locale] = await Promise.all([
    getTranslations('profileFields'),
    getTranslations('courseFields'),
    getLocale(),
  ]);
  const fields =
    kind === 'course'
      ? (await listCourseFields(db)).map((f) => ({ ...f, label: courseFieldLabel(f, locale) }))
      : (await listProfileFields(db)).map((f) => ({ ...f, label: profileFieldLabel(f, locale) }));
  const languages = await Promise.all(fields.map((f) => editingLanguages(db, f.name)));
  const newLanguages = await editingLanguages(db);
  return (
    <div className="grid max-w-4xl gap-6">
      <PageHeader
        title={kind === 'course' ? tcf('title') : tp('title')}
        description={kind === 'course' ? tcf('description') : tp('description')}
        className="mb-0"
      />
      {fields.length ? null : (
        <p className="text-sm text-muted-foreground">
          {kind === 'course' ? tcf('empty') : tp('empty')}
        </p>
      )}
      {fields.map((f, i) => (
        <Card key={f.id}>
          <CardHeader className="flex-row flex-wrap items-center gap-2">
            <CardTitle className="mr-auto">{f.label}</CardTitle>
            <Badge>{f.shortName}</Badge>
            <Badge variant="neutral">{tp(`types.${f.type}`)}</Badge>
            {f.required ? <Badge variant="warning">{tp('required')}</Badge> : null}
            {'visible' in f && !f.visible ? <Badge variant="neutral">{tcf('hidden')}</Badge> : null}
            <FieldCommands
              kind={kind}
              id={f.id}
              name={f.label}
              first={i === 0}
              last={i === fields.length - 1}
            />
          </CardHeader>
          <CardContent>
            <FieldForm kind={kind} field={f} languages={languages[i]!} />
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>{tp('new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldForm kind={kind} languages={newLanguages} />
        </CardContent>
      </Card>
    </div>
  );
}
