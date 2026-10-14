'use client';

import { callModuleAction } from '@hubium/module-sdk/form';
import { isAnswered, typeDef } from '@hubium/questions';
import { Alert, Button, Card, CardContent } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { toast } from '@hubium/ui/theme';
import { Flag, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicQuestion } from '../public.ts';
import { questionBodies } from './qtypes.tsx';

const TIME_WARNINGS = [10, 5, 1];

type Answers = Record<string, unknown>;

function QuestionBody({
  q,
  value,
  onChange,
}: {
  q: PublicQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const Body = questionBodies[q.type];
  return <Body q={q} value={(value ?? {}) as Record<string, unknown>} onChange={onChange} />;
}

function formatLeft(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function AttemptPlayer({
  activityId,
  attemptId,
  questions,
  dueAt,
  serverNow,
  backUrl,
  reviewUrl,
}: {
  activityId: string;
  attemptId: string;
  questions: PublicQuestion[];
  dueAt: string | null;
  /** Server time at render: the countdown follows the server clock, not the device's. */
  serverNow: number;
  backUrl: string;
  reviewUrl: string;
}) {
  const t = useTranslations('mod.quiz');
  const router = useRouter();
  const pages = useMemo(
    () => [...new Set(questions.map((q) => q.page))].sort((a, b) => a - b),
    [questions],
  );
  const [page, setPage] = useState(pages[0] ?? 1);
  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries(questions.map((q) => [q.slot, q.response])),
  );
  const [flags, setFlags] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(questions.map((q) => [q.slot, q.flagged])),
  );
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const finishing = useRef(false);
  const skew = useRef(serverNow - Date.now());
  const due = dueAt ? new Date(dueAt).getTime() - skew.current : null;
  // The autosave timer must not restart on every keystroke, so it reads the latest state.
  const latest = useRef({ answers, dirty, flags });
  latest.current = { answers, dirty, flags };

  const save = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const { answers: current, dirty: keys, flags: currentFlags } = latest.current;
      if (!keys.size && opts.quiet) return true;
      setSaving(true);
      const sent = Object.fromEntries([...keys].map((k) => [k, current[k]]));
      const r = await callModuleAction<{ closed: boolean }>(activityId, 'save', {
        attemptId,
        answers: sent,
        flags: currentFlags,
      });
      setSaving(false);
      if (!r.ok || r.data?.closed) {
        if (r.ok) toast.warning(t('timeUp'));
        else toast.error(r.message ?? 'Error');
        if (r.ok || /closed/i.test(r.message ?? '')) router.push(reviewUrl);
        return false;
      }
      // Answers changed while the request was in flight stay unsaved.
      setDirty(
        (d) => new Set([...d].filter((k) => !(k in sent) || latest.current.answers[k] !== sent[k])),
      );
      if (!opts.quiet) toast.success(t('saved'));
      return true;
    },
    [activityId, attemptId, reviewUrl, router, t],
  );

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    const r = await callModuleAction(activityId, 'finish', { attemptId, answers });
    if (!r.ok) {
      finishing.current = false;
      toast.error(r.message ?? 'Error');
      return;
    }
    router.push(reviewUrl);
    router.refresh();
  }, [activityId, attemptId, answers, reviewUrl, router]);

  // Autosave every 30 s; timer tick every second.
  useEffect(() => {
    const id = setInterval(() => void save({ quiet: true }), 30_000);
    return () => clearInterval(id);
  }, [save]);
  useEffect(() => {
    if (!due) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [due]);
  useEffect(() => {
    if (due && now >= due) {
      toast.warning(t('timeUp'));
      void finish();
    }
  }, [due, now, finish, t]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.size) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const go = async (p: number) => {
    await save({ quiet: true });
    setPage(p);
    window.scrollTo({ top: 0 });
  };
  const onPage = questions.filter((q) => q.page === page);
  const unanswered = questions.filter(
    (q) => typeDef(q.type).grading !== 'none' && !isAnswered(q.type, answers[q.slot]),
  ).length;
  const left = due ? due - now : null;
  // Screen readers hear the time only at thresholds, not every second.
  const stage =
    left === null ? null : (TIME_WARNINGS.filter((m) => left <= m * 60_000).at(-1) ?? null);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_15rem]">
      <div className="grid content-start gap-4">
        {onPage.map((q) => (
          <Card key={q.slot} id={`q-${q.slot}`}>
            <CardContent className="grid gap-4 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{t('question', { n: q.slot })}</h3>
                  {q.maxMark ? (
                    <p className="text-xs text-muted-foreground">
                      {t('maxMark', { max: q.maxMark })}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={flags[q.slot] ? 'secondary' : 'ghost'}
                  aria-pressed={!!flags[q.slot]}
                  onClick={() => {
                    setFlags((f) => ({ ...f, [q.slot]: !f[q.slot] }));
                    setDirty((d) => new Set(d).add(String(q.slot)));
                  }}
                >
                  <Flag />
                  {flags[q.slot] ? t('flagged') : t('flag')}
                </Button>
              </div>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: question text is sanitised on save */}
              <div className="prose-content" dangerouslySetInnerHTML={{ __html: q.text }} />
              <QuestionBody
                q={q}
                value={answers[q.slot]}
                onChange={(v) => {
                  setAnswers((a) => ({ ...a, [q.slot]: v }));
                  setDirty((d) => new Set(d).add(String(q.slot)));
                }}
              />
            </CardContent>
          </Card>
        ))}
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="secondary"
            disabled={page === pages[0]}
            onClick={() => go(pages[pages.indexOf(page) - 1]!)}
          >
            {t('prev')}
          </Button>
          {page === pages.at(-1) ? (
            <Button onClick={() => setConfirm(true)}>{t('finish')}</Button>
          ) : (
            <Button onClick={() => go(pages[pages.indexOf(page) + 1]!)}>{t('next')}</Button>
          )}
        </div>
        {confirm ? (
          <Alert variant="warning" className="grid gap-2">
            <p>{t('finishConfirm')}</p>
            {unanswered ? (
              <p className="font-medium">{t('unanswered', { n: unanswered })}</p>
            ) : null}
            <div className="flex gap-2">
              <Button onClick={() => void finish()}>{t('finish')}</Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                ×
              </Button>
            </div>
          </Alert>
        ) : null}
      </div>
      <aside className="grid content-start gap-3 lg:sticky lg:top-20">
        {left !== null ? (
          <Card className={left < 60_000 ? 'border-destructive' : undefined}>
            <CardContent
              className="flex items-center gap-2 pt-4 font-mono text-lg"
              role="timer"
              aria-live="off"
            >
              <Timer className="size-5" aria-hidden />
              {t('timeLeft', { time: formatLeft(left) })}
            </CardContent>
          </Card>
        ) : null}
        <p className="sr-only" aria-live="assertive" aria-atomic="true">
          {stage ? t('timeWarning', { minutes: stage }) : ''}
        </p>
        <Card>
          <CardContent className="grid gap-3 pt-4">
            <p className="text-sm font-medium">{t('navigation')}</p>
            <nav aria-label={t('navigation')} className="flex flex-wrap gap-1.5">
              {questions.map((q) => (
                <button
                  key={q.slot}
                  type="button"
                  onClick={async () => {
                    if (q.page !== page) await go(q.page);
                    document.getElementById(`q-${q.slot}`)?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  aria-label={t('question', { n: q.slot })}
                  className={cn(
                    'relative size-9 rounded-md border text-sm',
                    isAnswered(q.type, answers[q.slot])
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border',
                    q.page === page && 'ring-2 ring-ring/50',
                  )}
                >
                  {q.slot}
                  {flags[q.slot] ? (
                    <span
                      className="absolute -right-1 -top-1 size-2.5 rounded-full bg-warning"
                      aria-hidden
                    />
                  ) : null}
                </button>
              ))}
            </nav>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {saving ? t('saving') : dirty.size ? '' : t('saved')}
            </p>
            <Button variant="outline" size="sm" onClick={() => void save()}>
              {t('saveNow')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => (await save({ quiet: true })) && router.push(backUrl)}
            >
              {t('backToQuiz')}
            </Button>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}
