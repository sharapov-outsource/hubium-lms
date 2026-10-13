import {
  aiFeaturesFor,
  consentStatus,
  getModule,
  getSetting,
  listQuestionCategories,
} from '@hubium/core';
import { PageHeader } from '@hubium/ui';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AiConsentCard } from '@/components/ai/consent-card';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { QuizGenerator } from './generator';

export const generateMetadata = titled('ai.quizgen', 'title');

export default async function AiQuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ category?: string; g?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const features = await aiFeaturesFor(ctx, courseId);
  if (!features.QUIZGEN || !(await ctx.perm.can('question:manage', courseId))) notFound();
  const t = await getTranslations('ai.quizgen');
  if (ctx.actor.kind !== 'user') notFound();
  const consent = await consentStatus(ctx.db, ctx.actor.userId, 'QUIZGEN');
  if (!consent.accepted)
    return <AiConsentCard feature="QUIZGEN" notice={await getSetting(ctx.db, 'ai.notice')} />;
  const [categories, activities] = await Promise.all([
    listQuestionCategories(ctx, courseId),
    ctx.db.activity.findMany({
      where: { courseId, deletedAt: null },
      orderBy: [{ section: { rank: 'asc' } }, { rank: 'asc' }],
      select: { id: true, name: true, moduleKey: true },
    }),
  ]);
  const usable = activities.filter(
    (a) => (getModule(a.moduleKey)?.ai?.tutorPolicy ?? 'include') === 'include',
  );
  return (
    <div className="grid gap-4">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <QuizGenerator
        courseId={courseId}
        generationId={sp.g ?? null}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        defaultCategory={sp.category ?? categories[0]?.id ?? ''}
        activities={usable.map((a) => ({ id: a.id, name: a.name }))}
      />
    </div>
  );
}
