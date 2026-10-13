import { getSetting, getTutorConversation, tutorStatus } from '@hubium/core';
import { Alert, Button } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { AiConsentCard } from '@/components/ai/consent-card';
import { titled } from '@/server/page-title';
import { getContext } from '@/server/session';
import { TutorChat } from './tutor-chat';

export const generateMetadata = titled('course', 'tabs.tutor');

export default async function TutorPage({
  params,
  searchParams,
}: {
  params: Promise<{ courseId: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const [{ courseId }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getContext();
  const status = await tutorStatus(ctx, courseId);
  if (!status.enabled) notFound();
  const [t, format] = await Promise.all([getTranslations('ai.tutor'), getFormatter()]);
  if (!status.consent.accepted)
    return <AiConsentCard feature="TUTOR" notice={await getSetting(ctx.db, 'ai.notice')} />;
  const conv = sp.c ? await getTutorConversation(ctx, sp.c).catch(() => null) : null;
  const base = `/course/${courseId}/tutor`;
  return (
    <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
      <nav aria-label={t('history')} className="grid content-start gap-1">
        <Button asChild variant="outline" size="sm" className="mb-2 w-fit">
          <Link href={base}>
            <Plus />
            {t('newChat')}
          </Link>
        </Button>
        {status.conversations.map((c) => (
          <Link
            key={c.id}
            href={`${base}?c=${c.id}`}
            aria-current={c.id === conv?.id ? 'page' : undefined}
            className={cn(
              'grid rounded-md px-2 py-1.5 text-sm',
              c.id === conv?.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-muted',
            )}
          >
            <span className="truncate">{c.title || t('untitled')}</span>
            <span className="text-xs text-muted-foreground">
              {format.relativeTime(c.updatedAt)}
            </span>
          </Link>
        ))}
      </nav>
      <div className="grid content-start gap-4">
        {status.blockedBy ? (
          <Alert variant="warning">{t('blocked', { name: status.blockedBy })}</Alert>
        ) : null}
        <TutorChat
          key={conv?.id ?? 'new'}
          courseId={courseId}
          conversationId={conv?.id ?? null}
          disabled={!!status.blockedBy}
          initial={(conv?.messages ?? []).map((m) => ({
            id: m.id,
            role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
            content: m.content,
            citations: m.citations as { index: number; title: string; url: string }[],
            rating: m.rating,
          }))}
        />
      </div>
    </div>
  );
}
