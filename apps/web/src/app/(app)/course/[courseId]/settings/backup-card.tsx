'use client';

import { Button, Card, CardContent, CardHeader, CardTitle, Select } from '@hubium/ui';
import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { duplicateCourseAction } from '@/server/actions/interchange';

export function BackupCard({
  courseId,
  fullName,
  shortName,
  categoryId,
  categories,
  canDuplicate,
}: {
  courseId: string;
  fullName: string;
  shortName: string;
  categoryId: string;
  categories: { id: string; name: string; depth: number }[];
  canDuplicate: boolean;
}) {
  const t = useTranslations('backup');
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('downloadHint')}</p>
          <Button asChild variant="outline">
            <a href={`/course/${courseId}/backup`} download>
              <Download />
              {t('download')}
            </a>
          </Button>
        </div>
        {canDuplicate ? (
          <ActionForm action={duplicateCourseAction} className="grid gap-3 border-t pt-4">
            <h3 className="font-medium">{t('duplicate')}</h3>
            <input type="hidden" name="courseId" value={courseId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                name="fullName"
                label={t('fullName')}
                defaultValue={t('copyOf', { name: fullName })}
                required
              />
              <FormField
                name="shortName"
                label={t('shortName')}
                defaultValue={`${shortName}-copy`}
                required
              />
            </div>
            <FormField name="categoryId" label={t('category')}>
              <Select id="f-categoryId" name="categoryId" defaultValue={categoryId}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {'  '.repeat(c.depth)}
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <SubmitButton className="w-fit">
              <Copy />
              {t('duplicateSubmit')}
            </SubmitButton>
          </ActionForm>
        ) : null}
      </CardContent>
    </Card>
  );
}
