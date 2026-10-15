'use client';

import { RichText } from '@hubium/editor/client';
import { callModuleAction } from '@hubium/module-sdk/form';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  Label,
  Select,
  Textarea,
} from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { toast } from '@hubium/ui/theme';
import { Timer } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { PlayerPage } from '../server.ts';

type Result = {
  correct: boolean;
  essay: boolean;
  response: string;
  retry: boolean;
  finished: boolean;
};

function useRun(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(action: string, input: Record<string, unknown>, done?: (data: T) => void) =>
    start(async () => {
      const r = await callModuleAction<T>(activityId, action, input);
      if (!r.ok) {
        toast.error(r.message ?? 'Error');
        router.refresh();
        return;
      }
      if (done) done(r.data as T);
      else router.refresh();
    });
  return { pending, run, refresh: () => router.refresh() };
}

/** Starts the lesson (or a teacher's try), asking for the password when it has one. */
export function StartLesson({
  activityId,
  label,
  preview,
  password,
}: {
  activityId: string;
  label: string;
  preview: boolean;
  password: boolean;
}) {
  const t = useTranslations('mod.lesson');
  const { pending, run } = useRun(activityId);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run('start', { preview, password: fd.get('password') ?? undefined });
      }}
    >
      {password && !preview ? (
        <div className="grid gap-1.5">
          <Label htmlFor="ls-pass">{t('password')}</Label>
          <Input id="ls-pass" name="password" type="password" required autoComplete="off" />
        </div>
      ) : null}
      <Button type="submit" disabled={pending} variant={preview ? 'outline' : 'primary'}>
        {label}
      </Button>
    </form>
  );
}

function TimeLeft({ dueAt, serverNow }: { dueAt: string; serverNow: number }) {
  const t = useTranslations('mod.lesson');
  const router = useRouter();
  const skew = useRef(serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + skew.current);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, new Date(dueAt).getTime() - now);
  const over = left === 0;
  useEffect(() => {
    // the server ends the attempt when it is asked next
    if (over) router.refresh();
  }, [over, router]);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span role="timer" className="inline-flex items-center gap-1 font-mono">
      <Timer className="size-4" aria-hidden />
      {t('timeLeft', { time: `${m}:${String(s).padStart(2, '0')}` })}
    </span>
  );
}

export function LessonPlayer({
  activityId,
  page,
  retry,
  menu,
  progress,
  score,
  dueAt,
  serverNow,
  preview,
  feedback,
}: {
  activityId: string;
  page: PlayerPage;
  /** The last answer here was wrong and may be tried again. */
  retry: boolean;
  menu: { id: string; title: string }[];
  progress: number | null;
  score: { earned: number; total: number } | null;
  dueAt: string | null;
  serverNow: number;
  preview: boolean;
  /** Say whether every answer was right. */
  feedback: boolean;
}) {
  const t = useTranslations('mod.lesson');
  const { pending, run, refresh } = useRun(activityId);
  const [result, setResult] = useState<Result | null>(null);
  const [answer, setAnswer] = useState<Record<string, unknown>>({});
  // a new page starts afresh
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the page changes
  useEffect(() => {
    setResult(null);
    setAnswer({});
  }, [page.id]);
  const send = () =>
    run<Result>('answer', { pageId: page.id, ...answer }, (r) => {
      const quiet = !r.retry && !r.essay && !r.response && !feedback;
      if (quiet) refresh();
      else setResult(r);
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_14rem]">
      <div className="grid content-start gap-4">
        {preview ? <Alert>{t('previewing')}</Alert> : null}
        <Card>
          <CardContent className="grid gap-4 pt-6">
            <h2 className="text-xl font-semibold">{page.title}</h2>
            {page.contents ? <RichText html={page.contents} /> : null}
            {'buttons' in page ? (
              <div
                className={cn('flex gap-2', page.horizontal ? 'flex-wrap' : 'flex-col items-start')}
              >
                {page.buttons.map((b) => (
                  <Button
                    key={b.id}
                    disabled={pending}
                    onClick={() => run('choose', { pageId: page.id, answerId: b.id })}
                  >
                    {b.text}
                  </Button>
                ))}
              </div>
            ) : result ? (
              <ResultPanel
                result={result}
                feedback={feedback}
                pending={pending}
                onRetry={() => {
                  setResult(null);
                  setAnswer({});
                }}
                onSkip={() => run('skip', { pageId: page.id })}
                onNext={refresh}
              />
            ) : (
              <form
                className="grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                {retry ? <Alert variant="warning">{t('tryAgainHint')}</Alert> : null}
                <QuestionInput page={page} value={answer} onChange={setAnswer} />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>
                    {t('submit')}
                  </Button>
                  {retry ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() => run('skip', { pageId: page.id })}
                    >
                      {t('skip')}
                    </Button>
                  ) : null}
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
      <aside className="grid content-start gap-3 text-sm" aria-label={t('aside')}>
        {dueAt ? <TimeLeft dueAt={dueAt} serverNow={serverNow} /> : null}
        {progress !== null ? (
          <div className="grid gap-1">
            <span className="text-muted-foreground">{t('progress', { percent: progress })}</span>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('progressLabel')}
            >
              <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
            </div>
          </div>
        ) : null}
        {score ? <p className="text-muted-foreground">{t('ongoing', score)}</p> : null}
        {menu.length ? (
          <nav aria-label={t('menu')} className="grid gap-1">
            {menu.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={pending}
                aria-current={m.id === page.id ? 'page' : undefined}
                onClick={() => run('goTo', { pageId: m.id })}
                className="rounded-md px-2 py-1 text-left hover:bg-muted aria-[current=page]:bg-secondary aria-[current=page]:font-semibold"
              >
                {m.title}
              </button>
            ))}
          </nav>
        ) : null}
      </aside>
    </div>
  );
}

function ResultPanel({
  result,
  feedback,
  pending,
  onRetry,
  onSkip,
  onNext,
}: {
  result: Result;
  feedback: boolean;
  pending: boolean;
  onRetry(): void;
  onSkip(): void;
  onNext(): void;
}) {
  const t = useTranslations('mod.lesson');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} className="grid gap-3 outline-none" aria-live="polite">
      {result.essay ? (
        <Alert>{t('essaySent')}</Alert>
      ) : feedback || result.retry ? (
        <Alert variant={result.correct ? 'success' : 'warning'}>
          {result.correct ? t('correct') : t('wrong')}
        </Alert>
      ) : null}
      {result.response ? <p className="whitespace-pre-line">{result.response}</p> : null}
      <div className="flex flex-wrap gap-2">
        {result.retry ? (
          <>
            <Button onClick={onRetry} disabled={pending}>
              {t('tryAgain')}
            </Button>
            <Button variant="outline" onClick={onSkip} disabled={pending}>
              {t('skip')}
            </Button>
          </>
        ) : (
          <Button onClick={onNext} disabled={pending}>
            {result.finished ? t('seeResult') : t('continue')}
          </Button>
        )}
      </div>
    </div>
  );
}

function QuestionInput({
  page,
  value,
  onChange,
}: {
  page: PlayerPage;
  value: Record<string, unknown>;
  onChange(v: Record<string, unknown>): void;
}) {
  const t = useTranslations('mod.lesson');
  const name = `lp-${page.id}`;
  if ('choices' in page) {
    if (page.multiple) {
      const chosen = (value.choices as string[] | undefined) ?? [];
      return (
        <fieldset className="grid gap-2">
          <legend className="sr-only">{t('yourAnswer')}</legend>
          {page.choices.map((c) => (
            <label key={c.id} htmlFor={`${name}-${c.id}`} className="flex items-center gap-2">
              <Checkbox
                id={`${name}-${c.id}`}
                checked={chosen.includes(c.id)}
                onChange={(e) =>
                  onChange({
                    choices: e.target.checked
                      ? [...chosen, c.id]
                      : chosen.filter((x) => x !== c.id),
                  })
                }
              />
              {c.text}
            </label>
          ))}
        </fieldset>
      );
    }
    return (
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t('yourAnswer')}</legend>
        {page.choices.map((c) => (
          <label
            key={c.id}
            htmlFor={`${name}-${c.id}`}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-muted',
              value.choice === c.id && 'border-accent bg-accent-soft',
            )}
          >
            <input
              id={`${name}-${c.id}`}
              type="radio"
              name={name}
              required
              checked={value.choice === c.id}
              onChange={() => onChange({ choice: c.id })}
            />
            {c.text}
          </label>
        ))}
      </fieldset>
    );
  }
  if ('lefts' in page) {
    const matches = (value.matches as string[] | undefined) ?? page.lefts.map(() => '');
    return (
      <div className="grid gap-2">
        {page.lefts.map((left, i) => (
          <div key={left} className="grid items-center gap-2 sm:grid-cols-2">
            <Label htmlFor={`${name}-${i}`}>{left}</Label>
            <Select
              id={`${name}-${i}`}
              value={matches[i] ?? ''}
              onChange={(e) =>
                onChange({ matches: matches.map((m, k) => (k === i ? e.target.value : m)) })
              }
            >
              <option value="">{t('chooseMatch')}</option>
              {page.rights.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
    );
  }
  if (page.type === 'essay')
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={name}>{t('yourAnswer')}</Label>
        <Textarea
          id={name}
          rows={8}
          required
          maxLength={100_000}
          value={(value.text as string) ?? ''}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </div>
    );
  return (
    <div className="grid max-w-sm gap-1.5">
      <Label htmlFor={name}>{t('yourAnswer')}</Label>
      <Input
        id={name}
        required
        autoComplete="off"
        inputMode={page.type === 'numerical' ? 'decimal' : 'text'}
        value={(value.text as string) ?? ''}
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}
