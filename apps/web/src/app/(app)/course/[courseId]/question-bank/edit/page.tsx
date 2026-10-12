import { listQuestionCategories } from '@hubium/core';
import { type QuestionType, questionTypes } from '@hubium/questions';
import { Button, PageHeader } from '@hubium/ui';
import Link from 'next/link';
import { forbidden, notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { getContext } from '@/server/session';
import { QuestionEditor } from './question-editor';

export default async function EditQuestionPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ id?: string; type?: string; category?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  if (!(await ctx.perm.can('question:manage', courseId))) forbidden();
  const t = await getTranslations('qbank');
  const categories = await listQuestionCategories(ctx, courseId);
  const q = sp.id
    ? await db.question.findFirst({ where: { id: sp.id, category: { contextId: courseId } } })
    : null;
  if (sp.id && !q) notFound();
  const type = (q?.type ?? sp.type) as QuestionType;
  if (!questionTypes.includes(type)) notFound();
  return (
    <>
      <PageHeader
        title={q ? q.name : t(`types.${type}`)}
        description={t(`types.${type}`)}
        actions={
          <Button asChild variant="ghost">
            <Link href={`/course/${courseId}/question-bank`}>← {t('back')}</Link>
          </Button>
        }
      />
      <QuestionEditor
        courseId={courseId}
        type={type}
        categories={categories.map((c) => ({ id: c.id, name: c.name || t('defaultCategory') }))}
        initial={{
          id: q?.id,
          categoryId: q?.categoryId ?? sp.category ?? categories[0]!.id,
          name: q?.name ?? '',
          text: q?.text ?? '',
          generalFeedback: q?.generalFeedback ?? '',
          defaultMark: q ? Number(q.defaultMark) : 1,
          status: q?.status ?? 'READY',
          data: (q?.data as Record<string, unknown>) ?? null,
        }}
      />
    </>
  );
}
