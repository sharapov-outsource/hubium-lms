'use client';

import { Card, CardContent, CardHeader, CardTitle, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { setCourseAiFeatureAction } from '@/server/actions/ai';

type Feature = 'QUIZGEN' | 'GRADING_ASSIST' | 'TUTOR';

/** Per-course switches for the AI features the site has enabled. */
export function CourseAiCard({
  courseId,
  features,
}: {
  courseId: string;
  features: { feature: Feature; enabled: boolean }[];
}) {
  const t = useTranslations('ai');
  const [pending, start] = useTransition();
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{t('course.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">{t('course.hint')}</p>
        {features.map(({ feature, enabled }) => (
          <label
            key={feature}
            htmlFor={`ai-${feature}`}
            className="flex items-center gap-2 text-sm"
          >
            <Checkbox
              id={`ai-${feature}`}
              defaultChecked={enabled}
              disabled={pending}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                start(async () => {
                  const r = await setCourseAiFeatureAction(courseId, feature, on);
                  if (r.ok) toast.success(t('saved'));
                  else toast.error(r.message);
                });
              }}
            />
            {t(`features.${feature}`)}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
