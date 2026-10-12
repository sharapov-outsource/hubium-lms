'use client';

import { Button, Card, CardContent, Textarea } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '@/components/ai/markdown';
import { rateTutorAction } from '@/server/actions/ai';

interface Citation {
  index: number;
  title: string;
  url: string;
}

interface ChatMessage {
  id: string | null;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  rating: number | null;
  error?: boolean;
}

type TutorEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; messageId: string; citations: Citation[] }
  | { type: 'error'; code: string; message: string };

export function TutorChat({
  courseId,
  conversationId: initialId,
  initial,
  disabled,
}: {
  courseId: string;
  conversationId: string | null;
  initial: ChatMessage[];
  disabled: boolean;
}) {
  const t = useTranslations('ai.tutor');
  const tl = useTranslations('ai.limit');
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [conversationId, setConversationId] = useState(initialId);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new chunk
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => [...ms.slice(0, -1), fn(ms.at(-1)!)]);

  const errorText = (r: { code?: string; message?: string; details?: Record<string, unknown> }) => {
    if (r.code === 'RATE_LIMITED') {
      const kind = r.details?.kind as 'perMinute' | 'userDaily' | 'courseMonthly' | undefined;
      return tl(kind ?? 'perMinute');
    }
    if (r.code === 'REFUSED') return t('refused');
    if (r.details?.tutorBlocked) return t('blocked', { name: String(r.details.tutorBlocked) });
    return t('failed');
  };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setMessages((ms) => [
      ...ms,
      { id: null, role: 'user', content: text, citations: [], rating: null },
      { id: null, role: 'assistant', content: '', citations: [], rating: null },
    ]);
    try {
      const res = await fetch('/api/ai/tutor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseId, conversationId, message: text }),
      });
      if (!res.ok || !res.body) {
        const r = await res.json().catch(() => ({}));
        if (r.details?.consent) return router.refresh();
        return patchLast((m) => ({ ...m, content: errorText(r), error: true }));
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as TutorEvent;
          if (ev.type === 'start') {
            setConversationId(ev.conversationId);
            window.history.replaceState(null, '', `?c=${ev.conversationId}`);
          } else if (ev.type === 'delta') {
            patchLast((m) => ({ ...m, content: m.content + ev.text }));
          } else if (ev.type === 'done') {
            patchLast((m) => ({ ...m, id: ev.messageId, citations: ev.citations }));
          } else {
            patchLast((m) => ({ ...m, content: errorText(ev), error: true }));
          }
        }
      }
    } catch {
      patchLast((m) => ({ ...m, content: t('failed'), error: true }));
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const rate = async (m: ChatMessage, value: -1 | 1) => {
    if (!m.id) return;
    const next = m.rating === value ? null : value;
    setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, rating: next } : x)));
    await rateTutorAction(m.id, next);
  };

  return (
    <Card>
      <CardContent className="grid gap-4 pt-5">
        <ol aria-live="polite" aria-label={t('title')} className="grid gap-4">
          {messages.length === 0 ? (
            <li className="text-sm text-muted-foreground">{t('empty')}</li>
          ) : null}
          {messages.map((m, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: messages only append
              key={i}
              className={cn(
                'grid gap-2 rounded-lg px-3 py-2',
                m.role === 'user' ? 'ml-auto max-w-[85%] bg-accent-soft' : 'bg-muted/50',
                m.error && 'border border-destructive/40',
              )}
            >
              <span className="sr-only">{m.role === 'user' ? t('you') : t('tutor')}</span>
              {m.role === 'user' ? (
                <p className="whitespace-pre-wrap text-sm">{m.content}</p>
              ) : m.content ? (
                <Markdown text={m.content} />
              ) : (
                <span className="text-sm text-muted-foreground">{t('thinking')}</span>
              )}
              {m.citations.length ? (
                <div className="text-xs">
                  <span className="text-muted-foreground">{t('sources')}: </span>
                  {m.citations.map((c) => (
                    <Link key={c.index} href={c.url} className="mr-2 text-accent underline">
                      [{c.index}] {c.title}
                    </Link>
                  ))}
                </div>
              ) : null}
              {m.role === 'assistant' && m.id ? (
                <div className="flex gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('helpful')}
                    aria-pressed={m.rating === 1}
                    onClick={() => rate(m, 1)}
                  >
                    <ThumbsUp className={cn(m.rating === 1 && 'fill-current')} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('notHelpful')}
                    aria-pressed={m.rating === -1}
                    onClick={() => rate(m, -1)}
                  >
                    <ThumbsDown className={cn(m.rating === -1 && 'fill-current')} />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        <div ref={endRef} />
        <form onSubmit={send} className="flex items-end gap-2">
          <label htmlFor="tutor-input" className="sr-only">
            {t('placeholder')}
          </label>
          <Textarea
            id="tutor-input"
            value={input}
            disabled={disabled}
            maxLength={4000}
            placeholder={t('placeholder')}
            className="min-h-12"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button type="submit" disabled={disabled || busy || !input.trim()} aria-label={t('send')}>
            <Send />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t('disclaimer')}</p>
      </CardContent>
    </Card>
  );
}
