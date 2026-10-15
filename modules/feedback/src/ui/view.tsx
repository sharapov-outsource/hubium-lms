import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Button, Card, CardContent } from '@hubium/ui';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  ANSWERED,
  type FeedbackSettingsT,
  feedbackAnalysis,
  feedbackItems,
  feedbackResponses,
  feedbackState,
  itemNumbers,
  itemPages,
  mySubmissions,
} from '../server.ts';
import { AnswerForm, DeleteResponse, ItemEditor } from './client.tsx';

type Props = ViewProps<FeedbackSettingsT>;
const TABS = ['answer', 'edit', 'analysis', 'responses'] as const;

export async function FeedbackView(props: Props) {
  const { activity: a, course, ctx, searchParams: sp } = props;
  const t = await getTranslations('mod.feedback');
  const [canEdit, canReport] = await Promise.all([
    ctx.perm.can('mod.feedback:edititems', a.id),
    ctx.perm.can('mod.feedback:viewreports', a.id),
  ]);
  const base = `/course/${course.id}/a/${a.id}`;
  const tabs = TABS.filter((k) => k === 'answer' || (k === 'edit' ? canEdit : canReport));
  const tab = tabs.find((k) => k === sp.tab) ?? 'answer';
  return (
    <div className="grid max-w-3xl gap-5">
      {tabs.length > 1 ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('tabsLabel')}>
          {tabs.map((k) => (
            <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
              <Link
                href={k === 'answer' ? base : `${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
              >
                {t(`tabs.${k}`)}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
      {tab === 'edit' ? (
        <EditTab {...props} />
      ) : tab === 'analysis' ? (
        <AnalysisTab {...props} />
      ) : tab === 'responses' ? (
        <ResponsesTab {...props} />
      ) : (
        <AnswerTab {...props} />
      )}
    </div>
  );
}

async function AnswerTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.feedback'), getFormatter()]);
  const s = a.settings;
  const [items, canComplete, submitted] = await Promise.all([
    feedbackItems(ctx, a.id),
    ctx.perm.can('mod.feedback:complete', a.id),
    mySubmissions(ctx, a),
  ]);
  const state = feedbackState(s, ctx.now);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short' });
  const numbers = itemNumbers(items);
  const questions = items.some((i) => ANSWERED.includes(i.type));
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Badge variant="neutral">{s.anonymous ? t('anonymousBadge') : t('namedBadge')}</Badge>
        {s.opensAt ? <span>{t('opensAtShort', { time: when(s.opensAt) })}</span> : null}
        {s.closesAt ? <span>{t('closesAtShort', { time: when(s.closesAt) })}</span> : null}
      </div>
      {!canComplete ? (
        questions ? (
          <Card>
            <CardContent className="pt-6">
              <p className="mb-4 text-sm text-muted-foreground">{t('preview')}</p>
              <AnswerPreview items={items} numbers={s.autoNumbering ? numbers : null} />
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noItems')}</p>
        )
      ) : state === 'notOpen' ? (
        <Alert>{t('notOpen', { time: when(s.opensAt!) })}</Alert>
      ) : state === 'closed' ? (
        <Alert>{submitted ? t('thanks') : t('closedNoAnswer')}</Alert>
      ) : submitted && !s.multipleSubmit ? (
        <Alert variant="success">{s.thankYou || t('thanks')}</Alert>
      ) : !questions ? (
        <p className="text-sm text-muted-foreground">{t('noItems')}</p>
      ) : (
        <Card>
          <CardContent className="pt-6">
            {submitted ? (
              <Alert variant="success" className="mb-4">
                {s.thankYou || t('thanks')} {t('answerAgain')}
              </Alert>
            ) : null}
            <AnswerForm
              activityId={a.id}
              pages={itemPages(items)}
              numbers={s.autoNumbering ? Object.fromEntries(numbers) : null}
            />
          </CardContent>
        </Card>
      )}
      {canComplete && submitted && s.showAnalysis ? <AnalysisTab activity={a} ctx={ctx} /> : null}
    </div>
  );
}

/** The questions as learners will see them, without a way to send them. */
function AnswerPreview({
  items,
  numbers,
}: {
  items: Awaited<ReturnType<typeof feedbackItems>>;
  numbers: Map<string, number> | null;
}) {
  return (
    <ol className="grid gap-3">
      {items
        .filter((i) => i.type !== 'pagebreak')
        .map((i) => (
          <li key={i.id} className="grid gap-1 text-sm">
            <span className={i.type === 'info' ? 'whitespace-pre-line' : 'font-medium'}>
              {numbers?.get(i.id) ? `${numbers.get(i.id)}. ` : ''}
              {i.label}
            </span>
            {i.type === 'choice' ? (
              <span className="text-muted-foreground">{i.choices.join(' · ')}</span>
            ) : null}
          </li>
        ))}
    </ol>
  );
}

async function EditTab({ activity: a, ctx }: Props) {
  const items = await feedbackItems(ctx, a.id);
  return (
    <ItemEditor
      activityId={a.id}
      items={items}
      numbers={a.settings.autoNumbering ? Object.fromEntries(itemNumbers(items)) : {}}
    />
  );
}

async function AnalysisTab({ activity: a, ctx }: Pick<Props, 'activity' | 'ctx'>) {
  const t = await getTranslations('mod.feedback');
  const r = await feedbackAnalysis(ctx, a);
  if (!r.visible) return null;
  return (
    <section aria-labelledby="fb-analysis" className="grid gap-4">
      <h2 id="fb-analysis" className="text-lg font-semibold">
        {t('analysis')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('responsesCount', { count: r.responses })}</p>
      {r.items.map((i) => (
        <Card key={i.id}>
          <CardContent className="grid gap-3 pt-5">
            <h3 className="font-medium">
              {i.number}. {i.label}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t('answeredCount', { count: i.answered })}
            </p>
            {i.choices ? (
              <ul className="grid gap-2">
                {i.choices.map((c) => (
                  <li key={c.text} className="grid gap-1">
                    <div className="flex justify-between gap-2 text-sm">
                      <span>{c.text}</span>
                      <span className="text-muted-foreground">
                        {c.count} · {c.percent}%
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`${c.text}: ${c.percent}%`}
                    >
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${c.percent}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : i.numbers !== undefined ? (
              i.numbers ? (
                <p className="text-sm">
                  {t('average')}: <strong>{i.numbers.average}</strong> · {t('min')}: {i.numbers.min}{' '}
                  · {t('max')}: {i.numbers.max}
                </p>
              ) : null
            ) : i.texts?.length ? (
              <ul className="grid max-h-80 gap-1 overflow-y-auto text-sm">
                {i.texts.map((x, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: answers repeat and have no ids
                  <li key={n} className="whitespace-pre-line rounded-md bg-muted px-3 py-2">
                    {x}
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

async function ResponsesTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.feedback'), getFormatter()]);
  const [items, responses, canDelete] = await Promise.all([
    feedbackItems(ctx, a.id),
    feedbackResponses(ctx, a),
    ctx.perm.can('mod.feedback:deleteresponses', a.id),
  ]);
  const numbers = itemNumbers(items);
  const questions = items.filter((i) => ANSWERED.includes(i.type));
  return (
    <section aria-labelledby="fb-responses" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="fb-responses" className="text-lg font-semibold">
          {t('responses')}
        </h2>
        <span className="flex gap-3 text-sm">
          {(['csv', 'xlsx'] as const).map((f) => (
            <a
              key={f}
              href={`/api/mod/feedback/${a.id}/responses.${f}`}
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              <Download className="size-4" aria-hidden />
              {f.toUpperCase()}
            </a>
          ))}
        </span>
      </div>
      {responses.length ? (
        <ol className="grid gap-2">
          {responses.map((r, n) => (
            <li key={r.id}>
              <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium">
                    {r.user?.name ?? t('responseN', { n: n + 1 })}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    {format.dateTime(r.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                </summary>
                <dl className="mt-3 grid gap-2 text-sm">
                  {questions.map((q) => {
                    const v = r.answers[q.id];
                    return (
                      <div key={q.id}>
                        <dt className="text-muted-foreground">
                          {numbers.get(q.id)}. {q.label}
                        </dt>
                        <dd className="whitespace-pre-line">
                          {v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : String(v)}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {canDelete ? (
                  <div className="mt-2">
                    <DeleteResponse activityId={a.id} id={r.id} />
                  </div>
                ) : null}
              </details>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noResponses')}</p>
      )}
    </section>
  );
}
