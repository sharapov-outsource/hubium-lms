import { builtInLetters, hasOwnLetters, listScales, siteLetters } from '@hubium/core';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireCapability } from '@/server/session';
import { LettersForm, ScaleForm } from '../../course/[courseId]/grades/setup-parts';

export const generateMetadata = titled('adminGrades', 'title');

export default async function AdminGradesPage() {
  await requireCapability('site:config');
  const [t, tg, scales, own] = await Promise.all([
    getTranslations('adminGrades'),
    getTranslations('grades'),
    listScales(db, null),
    hasOwnLetters(db, SYSTEM_CONTEXT_ID),
  ]);
  const letters = own ? await siteLetters(db) : await builtInLetters(db);
  return (
    <div className="grid max-w-5xl gap-6">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{tg('siteScales')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6">
            {scales.map((s) => (
              <ScaleForm
                key={s.id}
                courseId={null}
                scale={{ id: s.id, name: s.name, items: s.items, used: s._count.gradeItems }}
              />
            ))}
            <div className="grid gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-semibold">{tg('newScale')}</h3>
              <ScaleForm courseId={null} />
            </div>
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{tg('letters')}</CardTitle>
            <CardDescription>
              {tg(own ? 'lettersFrom.site' : 'lettersFrom.builtin')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LettersForm courseId={null} letters={letters} own={own} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
