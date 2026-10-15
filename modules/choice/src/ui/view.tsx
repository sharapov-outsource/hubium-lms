import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@hubium/ui';
import { Download } from 'lucide-react';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  type ChoiceSettingsT,
  choiceResults,
  choiceState,
  myAnswers,
  takenPlaces,
} from '../server.ts';
import { AnswerForm, DeleteResponses, Withdraw } from './client.tsx';

type Props = ViewProps<ChoiceSettingsT>;

export async function ChoiceView({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.choice'), getFormatter()]);
  const s = a.settings;
  const [canChoose, canDelete, mine, results] = await Promise.all([
    ctx.perm.can('mod.choice:choose', a.id),
    ctx.perm.can('mod.choice:deleteresponses', a.id),
    myAnswers(ctx, a),
    choiceResults(ctx, a),
  ]);
  const teacher = await ctx.perm.can('mod.choice:readresponses', a.id);
  const state = choiceState(s, ctx.now);
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short' });
  // places left count everyone else's answers, seen or not
  const taken = s.limitAnswers
    ? await takenPlaces(ctx, a, ctx.actor.kind === 'user' ? ctx.actor.userId : null)
    : null;
  const left = new Map(
    s.options.map((o) => [o.id!, taken && o.limit ? o.limit - (taken.get(o.id!) ?? 0) : null]),
  );
  const total = results.options.reduce((n, o) => n + o.count, 0);
  const chosen = s.options.filter((o) => mine.includes(o.id!)).map((o) => o.text);

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {s.opensAt ? <span>{t('opensAtShort', { time: when(s.opensAt) })}</span> : null}
        {s.closesAt ? <span>{t('closesAtShort', { time: when(s.closesAt) })}</span> : null}
        {state === 'closed' ? <Badge variant="neutral">{t('closed')}</Badge> : null}
      </div>

      {canChoose ? (
        <Card>
          <CardContent className="grid gap-4 pt-6">
            {state === 'notOpen' ? <Alert>{t('notOpen', { time: when(s.opensAt!) })}</Alert> : null}
            {chosen.length ? (
              <p className="text-sm">
                {t('yourAnswer')}: <strong>{chosen.join(', ')}</strong>
              </p>
            ) : null}
            {state === 'open' && (!mine.length || s.allowUpdate) ? (
              <AnswerForm
                activityId={a.id}
                multiple={s.allowMultiple}
                mine={mine}
                options={s.options.map((o) => ({
                  id: o.id!,
                  text: o.text,
                  left: left.get(o.id!) ?? null,
                }))}
              />
            ) : state === 'notOpen' && s.showPreview ? (
              <ul className="grid list-disc gap-1 pl-5 text-sm">
                {s.options.map((o) => (
                  <li key={o.id}>{o.text}</li>
                ))}
              </ul>
            ) : null}
            {state === 'open' && mine.length && s.allowUpdate ? (
              <Withdraw activityId={a.id} />
            ) : null}
            {state === 'closed' && !mine.length ? (
              <p className="text-sm text-muted-foreground">{t('closedNoAnswer')}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {results.visible ? (
        <section aria-labelledby="ch-results" className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="ch-results" className="text-lg font-semibold">
              {t('results')}
            </h2>
            {teacher ? (
              <a
                href={`/api/mod/choice/${a.id}/responses.csv`}
                className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
              >
                <Download className="size-4" aria-hidden />
                {t('downloadCsv')}
              </a>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('answeredCount', { count: results.answered })}
          </p>
          <ul className="grid gap-3">
            {results.options.map((o) => {
              const pct = total ? Math.round((o.count / total) * 100) : 0;
              return (
                <li key={o.id} className="grid gap-1">
                  <div className="flex flex-wrap justify-between gap-2 text-sm">
                    <span className="font-medium">{o.text}</span>
                    <span className="text-muted-foreground">
                      {t('votes', { count: o.count })} · {pct}%
                      {o.limit ? ` · ${t('ofLimit', { limit: o.limit })}` : ''}
                    </span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-muted"
                    role="img"
                    aria-label={`${o.text}: ${pct}%`}
                  >
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  {o.users.length ? (
                    <p className="text-xs text-muted-foreground">
                      {o.users.map((u) => u.name).join(', ')}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {results.unanswered?.length ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('notAnswered')}: </span>
              {results.unanswered.map((u) => u.name).join(', ')}
            </p>
          ) : null}
        </section>
      ) : canChoose && s.showResults !== 'never' ? (
        <p className="text-sm text-muted-foreground">
          {s.showResults === 'afterClose' ? t('resultsAfterClose') : t('resultsAfterAnswer')}
        </p>
      ) : null}

      {teacher && canDelete && results.answered ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('responses')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DeleteResponses
              activityId={a.id}
              people={dedupe(
                results.options.flatMap((o) => o.users.map((u) => ({ ...u, option: o.text }))),
              )}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** One row per person, with all their options. */
function dedupe(rows: { id: string; name: string; option: string }[]) {
  const out = new Map<string, { id: string; name: string; options: string[] }>();
  for (const r of rows) {
    const p = out.get(r.id) ?? { id: r.id, name: r.name, options: [] };
    p.options.push(r.option);
    out.set(r.id, p);
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}
