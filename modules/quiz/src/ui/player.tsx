'use client';

import { callModuleAction, useFailureText } from '@hubium/module-sdk/form';
import { isAnswered } from '@hubium/questions';
import { Alert, Badge, Button, Card, CardContent } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { toast } from '@hubium/ui/theme';
import { Check, Flag, RotateCcw, Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveQuestion, LiveState, PublicQuestion } from '../public.ts';
import { bodyShowsText, questionBodies } from './qtypes.tsx';

const TIME_WARNINGS = [10, 5, 1];
/** Why an action on a closed attempt is refused: the attempt then opens in its review. */
const CLOSED = 'mod.quiz.errors.closedAttempt';

type Answers = Record<string, unknown>;

function QuestionBody({
  q,
  value,
  onChange,
  readOnly,
}: {
  q: PublicQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly: boolean;
}) {
  const Body = questionBodies[q.type];
  return (
    <Body
      q={q}
      value={(value ?? {}) as Record<string, unknown>}
      onChange={onChange}
      readOnly={readOnly}
    />
  );
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** What a check said: verdict, mark, feedback, the hint and the tries left. */
function QuestionFeedback({ live }: { live: LiveState }) {
  const t = useTranslations('mod.quiz');
  const f = live.feedback;
  if (!f) return null;
  return (
    <div
      data-feedback
      tabIndex={-1}
      className={cn(
        'grid gap-2 rounded-lg border p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        f.verdict === 'correct' && 'border-success/50 bg-success/5',
        f.verdict === 'partial' && 'border-warning/50 bg-warning/5',
        f.verdict === 'incorrect' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            f.verdict === 'correct'
              ? 'success'
              : f.verdict === 'incorrect'
                ? 'destructive'
                : 'warning'
          }
        >
          {t(f.verdict)}
        </Badge>
        {f.mark !== null ? (
          <span className="text-xs text-muted-foreground">
            {t('behaviours.markNow', { mark: fmt(f.mark) })}
          </span>
        ) : null}
      </div>
      {f.texts.map((html, k) => (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: answer feedback is sanitised on save
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed per check
        <div key={k} className="prose-content" dangerouslySetInnerHTML={{ __html: html }} />
      ))}
      {f.numCorrect ? (
        <p>
          {t('behaviours.numCorrect', { right: f.numCorrect.right, total: f.numCorrect.total })}
        </p>
      ) : null}
      {f.hint ? (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('behaviours.hint')}</p>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: hints are sanitised on save */}
          <div className="prose-content" dangerouslySetInnerHTML={{ __html: f.hint }} />
        </div>
      ) : null}
      {f.rightAnswer ? (
        <p className="text-success">{t('correctAnswer', { answer: f.rightAnswer })}</p>
      ) : null}
      {live.state === 'TRYAGAIN' && live.triesLeft !== null ? (
        <p className="text-xs text-muted-foreground">
          {t('behaviours.triesLeft', { n: live.triesLeft })}
        </p>
      ) : null}
    </div>
  );
}

function formatLeft(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

interface NavItem {
  slot: number;
  page: number;
  graded: boolean;
  answered: boolean;
  flagged: boolean;
}

export function AttemptPlayer({
  activityId,
  attemptId,
  questions,
  navMethod,
  currentPage,
  pages,
  navigation,
  dueAt,
  serverNow,
  backUrl,
  reviewUrl,
}: {
  activityId: string;
  attemptId: string;
  /** All questions, or only the current page with sequential navigation. */
  questions: LiveQuestion[];
  navMethod: 'free' | 'sequential';
  currentPage: number;
  pages: number[];
  /** Every question's place and saved state, for the navigation panel. */
  navigation: NavItem[];
  dueAt: string | null;
  /** Server time at render: the countdown follows the server clock, not the device's. */
  serverNow: number;
  backUrl: string;
  reviewUrl: string;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.quiz');
  const tc = useTranslations('common');
  const router = useRouter();
  const sequential = navMethod === 'sequential';
  const [page, setPage] = useState(pages.includes(currentPage) ? currentPage : (pages[0] ?? 1));
  const shown = useMemo(() => new Set(questions.map((q) => q.slot)), [questions]);
  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries(questions.map((q) => [q.slot, q.response])),
  );
  // immediate and interactive: each question's state after checks
  const [live, setLive] = useState<Record<string, LiveState>>(() =>
    Object.fromEntries(
      questions.map((q) => [
        q.slot,
        { state: q.state, canCheck: q.canCheck, triesLeft: q.triesLeft, feedback: q.feedback },
      ]),
    ),
  );
  const [busy, setBusy] = useState<number | null>(null);
  // The button pressed goes away with a check or a new try: focus moves on once the
  // question has re-rendered (to "Try again" or the feedback, or back to the answer).
  const [refocus, setRefocus] = useState<{ slot: number; to: 'answer' | 'result' } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    const card = document.getElementById(`q-${refocus.slot}`);
    const target =
      refocus.to === 'answer'
        ? card?.querySelector<HTMLElement>(
            'input:not([disabled]), select:not([disabled]), textarea, [contenteditable="true"]',
          )
        : (card?.querySelector<HTMLElement>('[data-retry]') ??
          card?.querySelector<HTMLElement>('[data-feedback]'));
    target?.focus();
    setRefocus(null);
  }, [refocus]);
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
        else toast.error(failed(r));
        if (r.ok || r.reason === CLOSED) router.push(reviewUrl);
        return false;
      }
      // Answers changed while the request was in flight stay unsaved.
      setDirty(
        (d) => new Set([...d].filter((k) => !(k in sent) || latest.current.answers[k] !== sent[k])),
      );
      if (!opts.quiet) toast.success(t('saved'));
      return true;
    },
    [activityId, attemptId, failed, reviewUrl, router, t],
  );

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    const r = await callModuleAction(activityId, 'finish', { attemptId, answers });
    if (!r.ok) {
      finishing.current = false;
      toast.error(failed(r));
      return;
    }
    router.push(reviewUrl);
    router.refresh();
  }, [activityId, attemptId, answers, failed, reviewUrl, router]);

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

  // Check now (immediate, interactive) and try again after a wrong answer (interactive).
  const checkAction = async (slot: number, action: 'check' | 'tryAgain') => {
    setBusy(slot);
    const r = await callModuleAction<{ closed: boolean; question: LiveQuestion | null }>(
      activityId,
      action,
      action === 'check'
        ? { attemptId, slot, response: latest.current.answers[slot] ?? {} }
        : { attemptId, slot },
    );
    setBusy(null);
    if (!r.ok || r.data?.closed || !r.data?.question) {
      if (r.ok) toast.warning(t('timeUp'));
      else toast.error(failed(r));
      if (r.ok || r.reason === CLOSED) router.push(reviewUrl);
      return;
    }
    const q = r.data.question;
    setAnswers((a) => ({ ...a, [slot]: q.response }));
    setDirty((d) => {
      const next = new Set(d);
      next.delete(String(slot));
      return next;
    });
    setLive((l) => ({
      ...l,
      [slot]: {
        state: q.state,
        canCheck: q.canCheck,
        triesLeft: q.triesLeft,
        feedback: q.feedback,
      },
    }));
    setRefocus({ slot, to: action === 'tryAgain' ? 'answer' : 'result' });
  };

  // Moving saves the page's answers; the server remembers the page for resuming and, with
  // sequential navigation, refuses to go back.
  const go = async (p: number) => {
    const { answers: current, dirty: keys, flags: currentFlags } = latest.current;
    setSaving(true);
    const r = await callModuleAction<{ closed: boolean }>(activityId, 'page', {
      attemptId,
      answers: Object.fromEntries([...keys].map((k) => [k, current[k]])),
      flags: currentFlags,
      to: p,
    });
    setSaving(false);
    if (!r.ok || r.data?.closed) {
      if (r.ok) toast.warning(t('timeUp'));
      else toast.error(failed(r));
      if (r.ok || r.reason === CLOSED) router.push(reviewUrl);
      return;
    }
    setDirty(new Set());
    window.scrollTo({ top: 0 });
    // the next page's questions come from the server
    if (sequential) router.refresh();
    else setPage(p);
  };
  const onPage = questions.filter((q) => q.page === page);
  const answeredNow = (n: NavItem) => {
    const q = questions.find((x) => x.slot === n.slot);
    return q && shown.has(n.slot) ? isAnswered(q.type, answers[q.slot]) : n.answered;
  };
  const unanswered = navigation.filter((n) => n.graded && !answeredNow(n)).length;
  const nextPage = pages.find((p) => p > page);
  const prevPage = [...pages].reverse().find((p) => p < page);
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
              {bodyShowsText(q.type) ? null : (
                // biome-ignore lint/security/noDangerouslySetInnerHtml: question text is sanitised on save
                <div className="prose-content" dangerouslySetInnerHTML={{ __html: q.text }} />
              )}
              <QuestionBody
                q={q}
                value={answers[q.slot]}
                readOnly={live[q.slot]?.state !== undefined && live[q.slot]?.state !== 'TODO'}
                onChange={(v) => {
                  setAnswers((a) => ({ ...a, [q.slot]: v }));
                  setDirty((d) => new Set(d).add(String(q.slot)));
                }}
              />
              <div aria-live="polite" aria-atomic="true">
                {live[q.slot] ? <QuestionFeedback live={live[q.slot]!} /> : null}
              </div>
              {live[q.slot]?.canCheck || live[q.slot]?.state === 'TRYAGAIN' ? (
                <div className="flex flex-wrap items-center gap-3">
                  {live[q.slot]?.state === 'TRYAGAIN' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy !== null}
                      data-retry
                      onClick={() => void checkAction(q.slot, 'tryAgain')}
                    >
                      <RotateCcw />
                      {t('behaviours.tryAgain')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy !== null || !isAnswered(q.type, answers[q.slot])}
                      onClick={() => void checkAction(q.slot, 'check')}
                    >
                      <Check />
                      {t('behaviours.check')}
                    </Button>
                  )}
                  {live[q.slot]?.state === 'TODO' && live[q.slot]?.triesLeft !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {t('behaviours.triesLeft', { n: live[q.slot]!.triesLeft! })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
        {sequential && nextPage !== undefined ? (
          <p className="text-sm text-muted-foreground">{t('access.sequentialNotice')}</p>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2">
          {sequential ? (
            <span />
          ) : (
            <Button
              variant="secondary"
              disabled={prevPage === undefined || saving}
              onClick={() => prevPage !== undefined && go(prevPage)}
            >
              {t('prev')}
            </Button>
          )}
          {nextPage === undefined ? (
            <Button onClick={() => setConfirm(true)}>{t('finish')}</Button>
          ) : (
            <Button disabled={saving} onClick={() => go(nextPage)}>
              {t('next')}
            </Button>
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
                {tc('cancel')}
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
              {navigation.map((n) => (
                <button
                  key={n.slot}
                  type="button"
                  // sequential: only the questions of this page can be reached
                  disabled={sequential && n.page !== page}
                  onClick={async () => {
                    if (n.page !== page) await go(n.page);
                    document.getElementById(`q-${n.slot}`)?.scrollIntoView({ behavior: 'smooth' });
                  }}
                  aria-label={t('question', { n: n.slot })}
                  aria-current={n.page === page ? 'true' : undefined}
                  className={cn(
                    'relative size-9 rounded-md border text-sm disabled:opacity-50',
                    answeredNow(n) ? 'border-accent bg-accent-soft text-accent' : 'border-border',
                    n.page === page && 'ring-2 ring-ring/50',
                  )}
                >
                  {n.slot}
                  {(shown.has(n.slot) ? flags[n.slot] : n.flagged) ? (
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
