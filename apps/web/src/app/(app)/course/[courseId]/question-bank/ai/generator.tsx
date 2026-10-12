'use client';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Field,
  Input,
  Progress,
  Select,
} from '@hubium/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { ActionForm, SubmitButton } from '@/components/action-form';
import { quizGenStatusAction, reviewQuizGenAction, startQuizGenAction } from '@/server/actions/ai';

type Status = Extract<Awaited<ReturnType<typeof quizGenStatusAction>>, { ok: true }>['data'];
const TYPES = ['MULTICHOICE', 'TRUEFALSE', 'SHORTANSWER', 'NUMERICAL'] as const;

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

export function QuizGenerator({
  courseId,
  generationId,
  categories,
  defaultCategory,
  activities,
}: {
  courseId: string;
  generationId: string | null;
  categories: { id: string; name: string }[];
  defaultCategory: string;
  activities: { id: string; name: string }[];
}) {
  const t = useTranslations('ai.quizgen');
  const tq = useTranslations('qbank');
  const router = useRouter();
  const [id, setId] = useState(generationId);
  const [status, setStatus] = useState<Status | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      const r = await quizGenStatusAction(id);
      if (stop) return;
      if (r.ok) {
        setStatus(r.data);
        if (r.data.status === 'SUCCEEDED' || r.data.status === 'FAILED') return;
      }
      setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [id]);

  if (!id)
    return (
      <Card className="max-w-3xl">
        <CardContent className="pt-5">
          <ActionForm
            action={startQuizGenAction}
            className="grid gap-4"
            onSuccess={(r) => {
              setId(r.id);
              window.history.replaceState(null, '', `?g=${r.id}`);
            }}
          >
            <input type="hidden" name="courseId" value={courseId} />
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{t('sources')}</legend>
              {activities.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noSources')}</p>
              ) : null}
              {activities.map((a) => (
                <label
                  key={a.id}
                  htmlFor={`src-${a.id}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox id={`src-${a.id}`} name="activityIds" value={a.id} />
                  {a.name}
                </label>
              ))}
            </fieldset>
            <fieldset className="flex flex-wrap gap-4">
              <legend className="mb-1 w-full text-sm font-medium">{t('types')}</legend>
              {TYPES.map((type) => (
                <label
                  key={type}
                  htmlFor={`type-${type}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Checkbox
                    id={`type-${type}`}
                    name="types"
                    value={type}
                    defaultChecked={type === 'MULTICHOICE'}
                  />
                  {tq(`types.${type}`)}
                </label>
              ))}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('count')} htmlFor="qg-count">
                <Input id="qg-count" name="count" type="number" min={1} max={20} defaultValue={5} />
              </Field>
              <Field label={t('difficulty')} htmlFor="qg-difficulty">
                <Select id="qg-difficulty" name="difficulty" defaultValue="medium">
                  {(['easy', 'medium', 'hard'] as const).map((d) => (
                    <option key={d} value={d}>
                      {t(`levels.${d}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('language')} htmlFor="qg-language">
                <Select id="qg-language" name="language" defaultValue="ru">
                  <option value="ru">Русский</option>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
            <Field label={tq('category')} htmlFor="qg-category">
              <Select id="qg-category" name="categoryId" defaultValue={defaultCategory}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || tq('defaultCategory')}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton className="w-fit">{t('generate')}</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    );

  if (!status || status.status === 'QUEUED' || status.status === 'RUNNING')
    return (
      <Card className="max-w-3xl">
        <CardContent className="grid gap-2 pt-5" aria-live="polite">
          <span className="text-sm">{t('working')}</span>
          <Progress value={status?.status === 'RUNNING' ? 60 : 20} label={t('working')} />
        </CardContent>
      </Card>
    );

  if (status.status === 'FAILED')
    return (
      <div className="grid max-w-3xl gap-3">
        <Alert variant="destructive">{t('failed', { error: status.error ?? '' })}</Alert>
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => {
            setId(null);
            setStatus(null);
            window.history.replaceState(null, '', '?');
          }}
        >
          {t('again')}
        </Button>
      </div>
    );

  const drafts = status.questions.filter((q) => q.status === 'DRAFT');
  return (
    <div className="grid max-w-3xl gap-4">
      <Alert variant={status.errors.length ? 'warning' : 'success'}>
        {t('done', { count: status.questions.length })}
        {status.errors.length ? (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {status.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
      </Alert>
      <ul className="grid gap-3">
        {status.questions.map((q) => (
          <li key={q.id}>
            <Card>
              <CardContent className="grid gap-2 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="mr-auto">{q.name}</strong>
                  <Badge>{tq(`types.${q.type}`)}</Badge>
                  <Badge variant={q.status === 'READY' ? 'success' : 'warning'}>
                    {tq(`statuses.${q.status}`)}
                  </Badge>
                </div>
                <p className="whitespace-pre-wrap text-sm">{plain(q.text)}</p>
                {q.status === 'DRAFT' ? (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <label htmlFor={`keep-${q.id}`} className="flex items-center gap-2">
                      <Checkbox
                        id={`keep-${q.id}`}
                        checked={!rejected.has(q.id)}
                        onChange={(e) => {
                          const next = new Set(rejected);
                          if (e.currentTarget.checked) next.delete(q.id);
                          else next.add(q.id);
                          setRejected(next);
                        }}
                      />
                      {t('keep')}
                    </label>
                    <Link
                      href={`/course/${courseId}/question-bank/edit?id=${q.id}`}
                      className="text-accent underline"
                    >
                      {t('edit')}
                    </Link>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {drafts.length ? (
        <Button
          className="w-fit"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const ids = drafts.map((q) => q.id);
              const r = await reviewQuizGenAction(
                id,
                ids.filter((x) => !rejected.has(x)),
                ids.filter((x) => rejected.has(x)),
              );
              if (r.ok) {
                const s = await quizGenStatusAction(id);
                if (s.ok) setStatus(s.data);
                router.refresh();
              }
            })
          }
        >
          {t('apply', { accept: drafts.length - rejected.size, reject: rejected.size })}
        </Button>
      ) : (
        <Button asChild variant="outline" className="w-fit">
          <Link href={`/course/${courseId}/question-bank`}>{t('toBank')}</Link>
        </Button>
      )}
    </div>
  );
}
