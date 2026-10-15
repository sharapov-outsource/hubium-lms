import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Button, Card, CardContent, EmptyState } from '@hubium/ui';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { isQuestion, isStructure, type PageType, pageTypes } from '../engine.ts';
import {
  type LessonSettingsT,
  lessonEssays,
  lessonPages,
  lessonReport,
  lessonState,
  lessonWindow,
} from '../server.ts';
import { AddPage, DeleteAttempt, EssayGrade, PageForm, PageTools } from './editor.tsx';
import { LessonPlayer, StartLesson } from './player.tsx';

type Props = ViewProps<LessonSettingsT>;
const TABS = ['lesson', 'edit', 'reports', 'essays'] as const;

export async function LessonView(props: Props) {
  const { activity: a, course, ctx, searchParams: sp } = props;
  const t = await getTranslations('mod.lesson');
  const [canEdit, canReport, canGrade] = await Promise.all([
    ctx.perm.can('mod.lesson:edit', a.id),
    ctx.perm.can('mod.lesson:viewreports', a.id),
    ctx.perm.can('mod.lesson:grade', a.id),
  ]);
  const base = `/course/${course.id}/a/${a.id}`;
  const allowed = { lesson: true, edit: canEdit, reports: canReport, essays: canGrade };
  const tabs = TABS.filter((k) => allowed[k]);
  const tab = tabs.find((k) => k === sp.tab) ?? 'lesson';
  return (
    <div className="grid gap-5">
      {tabs.length > 1 ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('tabsLabel')}>
          {tabs.map((k) => (
            <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
              <Link
                href={k === 'lesson' ? base : `${base}?tab=${k}`}
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
      ) : tab === 'reports' ? (
        <ReportsTab {...props} canGrade={canGrade} />
      ) : tab === 'essays' ? (
        <EssaysTab {...props} />
      ) : (
        <LessonTab {...props} canPreview={canReport} />
      )}
    </div>
  );
}

async function LessonTab({ activity: a, ctx, canPreview }: Props & { canPreview: boolean }) {
  const [t, format] = await Promise.all([getTranslations('mod.lesson'), getFormatter()]);
  const s = a.settings;
  if (ctx.actor.kind !== 'user') return null;
  const [canAttempt, st] = await Promise.all([
    ctx.perm.can('mod.lesson:attempt', a.id),
    lessonState(ctx, a, ctx.actor.userId),
  ]);
  if (st.current)
    return (
      <LessonPlayer
        activityId={a.id}
        page={st.current.page}
        retry={st.current.retry}
        menu={st.current.menu}
        progress={s.progressBar ? st.current.progress : null}
        score={st.current.score}
        dueAt={st.current.dueAt?.toISOString() ?? null}
        serverNow={ctx.now.getTime()}
        preview={st.current.preview}
        feedback={s.feedback}
      />
    );
  const when = (d: Date) => format.dateTime(d, { dateStyle: 'long', timeStyle: 'short' });
  const mine = st.past.filter((x) => x.preview === !canAttempt);
  const last = mine[mine.length - 1];
  const window = lessonWindow(s, ctx.now);
  return (
    <div className="grid max-w-3xl gap-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {s.opensAt ? <span>{t('opensAt', { time: when(new Date(s.opensAt)) })}</span> : null}
        {s.closesAt ? <span>{t('closesAt', { time: when(new Date(s.closesAt)) })}</span> : null}
        {s.timeLimitMin ? <span>{t('timeLimit', { minutes: s.timeLimitMin })}</span> : null}
        {s.practice ? <Badge variant="neutral">{t('practice')}</Badge> : null}
      </div>
      {last ? (
        <Card>
          <CardContent className="grid gap-2 pt-6">
            <h2 className="text-lg font-semibold">{t('ended')}</h2>
            {last.percent !== null && !s.practice ? (
              <p>
                {t('result', {
                  earned: last.earned,
                  total: last.total,
                  percent: Math.round(last.percent * 10) / 10,
                })}
              </p>
            ) : null}
            {last.pending ? (
              <p className="text-sm text-muted-foreground">
                {t('pendingEssays', { n: last.pending })}
              </p>
            ) : null}
            {mine.length > 1 && st.lessonPercent !== null && !s.practice ? (
              <p className="text-sm">
                {t(s.useMaxGrade ? 'gradeBest' : 'gradeMean', {
                  percent: Math.round(st.lessonPercent * 10) / 10,
                })}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {!st.hasPages ? (
        <EmptyState title={t('noPages')} />
      ) : canAttempt ? (
        window === 'notOpen' ? (
          <Alert>{t('notOpen')}</Alert>
        ) : window === 'closed' ? (
          <Alert>{t('closed')}</Alert>
        ) : st.canRetake ? (
          <StartLesson
            activityId={a.id}
            label={last ? t('retake') : t('start')}
            preview={false}
            password={!!s.password}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('noRetakes')}</p>
        )
      ) : canPreview ? (
        <StartLesson activityId={a.id} label={t('preview')} preview password={false} />
      ) : null}
    </div>
  );
}

async function EditTab({ activity: a, course, ctx, searchParams: sp }: Props) {
  const t = await getTranslations('mod.lesson');
  const base = `/course/${course.id}/a/${a.id}`;
  const pages = await lessonPages(ctx.db, a.id);
  const refs = pages.map((p) => ({ id: p.id, title: p.title, type: p.type }));
  const addType = pageTypes.find((k) => k === sp.add);
  const editing = sp.page ? pages.find((p) => p.id === sp.page) : undefined;
  if (addType || editing) {
    const type = (editing?.type ?? addType) as PageType;
    return (
      <div className="grid max-w-3xl gap-4">
        <h2 className="text-lg font-semibold">
          {editing ? t('edit.editPage') : t('edit.newPage', { type: t(`types.${type}`) })}
        </h2>
        <PageForm
          activityId={a.id}
          courseId={course.id}
          base={base}
          type={type}
          page={editing}
          afterId={sp.after ?? null}
          pages={refs}
          customScoring={a.settings.customScoring}
        />
      </div>
    );
  }
  const name = (id: string) => {
    const i = pages.findIndex((p) => p.id === id);
    return i < 0 ? '' : `${i + 1}. ${pages[i]!.title || t(`types.${pages[i]!.type}`)}`;
  };
  const jumpLabel = (jump: string) =>
    pages.some((p) => p.id === jump) ? name(jump) : t(`jumps.${jump}` as 'jumps.next');
  return (
    <div className="grid max-w-4xl gap-4">
      <AddPage base={base} afterId={null} label={t('edit.addFirst')} />
      {pages.length ? (
        <ol className="grid gap-2">
          {pages.map((p, i) => (
            <li key={p.id} className="grid gap-2 rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="grid gap-1">
                  <span className="font-medium">
                    {i + 1}. {p.title || t(`types.${p.type}`)}
                  </span>
                  <Badge
                    variant={isStructure(p.type) ? 'neutral' : 'accent'}
                    className="justify-self-start"
                  >
                    {t(`types.${p.type}`)}
                  </Badge>
                </div>
                <PageTools
                  activityId={a.id}
                  base={base}
                  page={{ id: p.id, title: p.title || t(`types.${p.type}`) }}
                  first={i === 0}
                  last={i === pages.length - 1}
                />
              </div>
              <ul className="grid gap-0.5 text-sm text-muted-foreground">
                {p.answers.map((x, k) => (
                  <li key={x.id}>
                    {p.type === 'content'
                      ? `«${x.text}»`
                      : p.type === 'matching'
                        ? k === 0
                          ? t('edit.allRight')
                          : t('edit.someWrong')
                        : isQuestion(p.type) && p.type !== 'essay'
                          ? x.text
                          : t('edit.after')}{' '}
                    → {jumpLabel(x.jump)}
                    {a.settings.customScoring && isQuestion(p.type) ? ` (${x.score})` : ''}
                  </li>
                ))}
              </ul>
              <AddPage base={base} afterId={p.id} label={t('edit.addAfter')} />
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title={t('edit.empty')} />
      )}
    </div>
  );
}

async function ReportsTab({ activity: a, ctx, canGrade }: Props & { canGrade: boolean }) {
  const [t, format] = await Promise.all([getTranslations('mod.lesson'), getFormatter()]);
  const report = await lessonReport(ctx, a);
  if (!report.length) return <p className="text-sm text-muted-foreground">{t('reports.empty')}</p>;
  const minutes = (from: Date, to: Date | null) =>
    to ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000)) : null;
  return (
    <ul className="grid max-w-4xl gap-3">
      {report.map((u) => (
        <li key={u.user.id}>
          <Card>
            <CardContent className="grid gap-3 pt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">{u.user.name}</h3>
                {u.percent !== null ? (
                  <span className="text-sm">
                    {t('reports.grade', { percent: Math.round(u.percent * 10) / 10 })}
                  </span>
                ) : null}
              </div>
              <ol className="grid gap-2">
                {u.attempts.map((at) => (
                  <li key={at.id}>
                    <details className="rounded-md border border-border p-2">
                      <summary className="cursor-pointer text-sm">
                        {t('reports.attempt', { n: at.number })} ·{' '}
                        {format.dateTime(at.startedAt, { dateStyle: 'medium', timeStyle: 'short' })}
                        {' · '}
                        {at.finishedAt
                          ? t('reports.done', {
                              percent: at.percent === null ? '—' : Math.round(at.percent * 10) / 10,
                              minutes: minutes(at.startedAt, at.finishedAt) ?? 0,
                            })
                          : t('reports.inProgress')}
                      </summary>
                      <ul className="mt-2 grid gap-1 text-sm">
                        {at.answers.map((x) => (
                          <li key={x.id}>
                            <span className="text-muted-foreground">{x.page}:</span>{' '}
                            {responseText(x.response)}{' '}
                            <Badge variant={x.correct ? 'success' : 'neutral'}>
                              {x.correct ? t('correct') : t('wrong')}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                      {canGrade ? (
                        <div className="mt-2">
                          <DeleteAttempt activityId={a.id} attemptId={at.id} />
                        </div>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function responseText(r: unknown): string {
  if (!r || typeof r !== 'object') return '—';
  const o = r as { text?: string; choice?: string; choices?: string[]; matches?: string[] };
  if (o.text !== undefined) return o.text.length > 200 ? `${o.text.slice(0, 199)}…` : o.text;
  if (o.matches) return o.matches.join(', ');
  return '✓';
}

async function EssaysTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.lesson'), getFormatter()]);
  const essays = await lessonEssays(ctx, a);
  if (!essays.length) return <p className="text-sm text-muted-foreground">{t('essays.empty')}</p>;
  return (
    <ul className="grid max-w-4xl gap-3">
      {essays.map((e) => (
        <li key={e.id}>
          <Card>
            <CardContent className="grid gap-3 pt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium">
                  {e.user.name} · {e.page}
                </h3>
                <span className="text-sm text-muted-foreground">
                  {format.dateTime(e.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  {e.score === null ? (
                    <Badge variant="warning" className="ml-2">
                      {t('essays.ungraded')}
                    </Badge>
                  ) : null}
                </span>
              </div>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">
                  {t('essays.question')}
                </summary>
                <RichText html={e.question} />
              </details>
              <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2">{e.text}</p>
              <EssayGrade
                activityId={a.id}
                stepId={e.id}
                max={e.max}
                score={e.score}
                comment={e.comment}
              />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
