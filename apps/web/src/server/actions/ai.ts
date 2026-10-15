'use server';

import {
  acceptConsent,
  deleteAiProvider,
  getQuizGeneration,
  rateTutorMessage,
  reindexAllCourses,
  reviewGeneratedQuestions,
  saveAiFeature,
  saveAiProvider,
  saveEmbeddingConfig,
  saveSiteSettings,
  setCourseAiFeature,
  startQuizGeneration,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

type Feature = 'QUIZGEN' | 'GRADING_ASSIST' | 'TUTOR';
const on = (fd: FormData, k: string) => fd.get(k) === 'on';
const num = (v: string | undefined) => (v?.trim() ? Number(v) : null);

export async function saveAiSiteAction(fd: FormData) {
  return runAction(async () => {
    await saveSiteSettings.run(await getContext(), {
      values: { 'ai.enabled': on(fd, 'enabled'), 'ai.notice': String(fd.get('notice') ?? '') },
    });
    revalidatePath('/admin/ai');
    return null;
  });
}

export async function saveAiProviderAction(fd: FormData) {
  return runAction(
    async () => {
      const v = formToObject(fd);
      const r = await saveAiProvider.run(await getContext(), {
        id: v.id || undefined,
        kind: v.kind,
        name: v.name,
        baseUrl: v.baseUrl ?? '',
        apiKey: v.apiKey || undefined,
        models: { generation: v.generation, cheap: v.cheap, premium: v.premium },
        jsonSchema: on(fd, 'jsonSchema'),
        streaming: on(fd, 'streaming'),
        enabled: on(fd, 'enabled'),
      });
      revalidatePath('/admin/ai');
      return r;
    },
    {
      fields: {
        'models.generation': 'generation',
        'models.cheap': 'cheap',
        'models.premium': 'premium',
      },
    },
  );
}

export async function deleteAiProviderAction(id: string) {
  return runAction(async () => {
    const r = await deleteAiProvider.run(await getContext(), { id });
    revalidatePath('/admin/ai');
    return r;
  });
}

export async function saveAiFeatureAction(fd: FormData) {
  return runAction(
    async () => {
      const v = formToObject(fd);
      const r = await saveAiFeature.run(await getContext(), {
        feature: v.feature,
        enabled: on(fd, 'enabled'),
        providerId: v.providerId || null,
        model: v.model || 'generation',
        effort: v.effort || null,
        limits: {
          userDailyTokens: num(v.userDailyTokens),
          courseMonthlyTokens: num(v.courseMonthlyTokens),
          perMinute: num(v.perMinute),
        },
        bumpNotice: on(fd, 'bumpNotice'),
      });
      revalidatePath('/admin/ai');
      return r;
    },
    { fields: { 'limits.': '' } },
  );
}

export async function saveEmbeddingsAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await saveEmbeddingConfig.run(await getContext(), {
      kind: v.kind || null,
      baseUrl: v.baseUrl ?? '',
      model: v.model ?? '',
      apiKey: v.apiKey || undefined,
    });
    revalidatePath('/admin/ai');
    return r;
  });
}

export async function reindexAllAction() {
  return runAction(async () => reindexAllCourses.run(await getContext(), {}));
}

export async function setCourseAiFeatureAction(
  courseId: string,
  feature: Feature,
  enabled: boolean,
) {
  return runAction(async () => {
    const r = await setCourseAiFeature.run(await getContext(), { courseId, feature, enabled });
    revalidatePath(`/course/${courseId}`, 'layout');
    return r;
  });
}

export async function acceptAiConsentAction(feature: Feature) {
  return runAction(async () => acceptConsent(await getContext(), feature));
}

export async function startQuizGenAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    return startQuizGeneration(await getContext(), {
      courseId: v.courseId,
      categoryId: v.categoryId,
      activityIds: fd.getAll('activityIds').map(String),
      types: fd.getAll('types').map(String),
      count: v.count,
      difficulty: v.difficulty,
      language: v.language,
    });
  });
}

export async function quizGenStatusAction(id: string) {
  return runAction(async () => {
    const g = await getQuizGeneration(await getContext(), id);
    return {
      status: g.status,
      error: g.error,
      errors: g.errors,
      questions: g.questions.map((q) => ({
        id: q.id,
        name: q.name,
        type: q.type,
        status: q.status,
        text: q.text,
      })),
    };
  });
}

export async function reviewQuizGenAction(id: string, accept: string[], reject: string[]) {
  return runAction(async () => {
    const ctx = await getContext();
    const g = await getQuizGeneration(ctx, id);
    const r = await reviewGeneratedQuestions(ctx, id, { accept, reject });
    revalidatePath(`/course/${g.courseId}/question-bank`);
    return r;
  });
}

export async function rateTutorAction(messageId: string, rating: -1 | 1 | null) {
  return runAction(async () => rateTutorMessage(await getContext(), messageId, rating));
}
