'use client';

import { Button, Card, CardContent, CardHeader, CardTitle } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { acceptAiConsentAction } from '@/server/actions/ai';
import { Markdown } from './markdown';

/** Privacy notice the user accepts before their first AI request for a feature. */
export function AiConsentCard({
  feature,
  notice,
}: {
  feature: 'QUIZGEN' | 'GRADING_ASSIST' | 'TUTOR';
  notice: string;
}) {
  const t = useTranslations('ai');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{t('consent.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice ? <Markdown text={notice} /> : <p className="text-sm">{t('consent.default')}</p>}
        <Button
          className="w-fit"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await acceptAiConsentAction(feature);
              if (!r.ok) return void toast.error(r.message);
              router.refresh();
            })
          }
        >
          {t('consent.accept')}
        </Button>
      </CardContent>
    </Card>
  );
}
