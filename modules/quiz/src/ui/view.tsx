import type { ViewProps } from '@hubium/module-sdk/ui';
import { typeDef } from '@hubium/questions';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  attemptsSeenBy,
  type QuizSettingsT,
  readAttempt,
  readQuizOverview,
  readReview,
  sumMaxMarks,
} from '../server.ts';
import { blankGaps } from './blank-gaps.ts';
import {
  AttemptActions,
  DeleteOverrideButton,
  GradeQuestionForm,
  OverrideForm,
  RegradePanel,
  SlotEditor,
} from './client.tsx';
import { AttemptPlayer } from './player.tsx';

type Props = ViewProps<QuizSettingsT>;

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export async function QuizView(props: Props) {
  const { activity: a, ctx, searchParams } = props;
  if (searchParams.attempt) return <AttemptPage {...props} attemptId={searchParams.attempt} />;
  if (searchParams.review) return <ReviewPage {...props} attemptId={searchParams.review} />;
  const manage = await ctx.perm.can('mod.quiz:viewreports', a.id);
  if (manage) return <TeacherView {...props} />;
  return <StudentView {...props} />;
}

function base(a: Props['activity']) {
  return `/course/${a.courseId}/a/${a.id}`;
}

async function StudentView({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.quiz'), getFormatter()]);
  if (ctx.actor.kind !== 'user') return null;
  const o = await readQuizOverview(ctx, a);
  const e = { openAt: o.openAt, closeAt: o.closeAt, timeLimitSec: o.timeLimitSec };
  const slotCount = o.questions;
  const attempts = o.attempts;
  return (
    <div className="grid max-w-3xl gap-5">
      <Card>
        <CardContent className="grid gap-2 pt-5 text-sm">
          <p>{t('info.questions', { n: slotCount })}</p>
          {e.timeLimitSec ? (
            <p>{t('info.timeLimit', { min: Math.round(e.timeLimitSec / 60) })}</p>
          ) : null}
          <p>
            {o.attemptsAllowed
              ? t('info.attempts', { used: attempts.length, total: o.attemptsAllowed })
              : t('info.attemptsUnlimited', { used: attempts.length })}
          </p>
          {e.openAt && e.openAt > ctx.now ? (
            <p>
              {t('info.opens', {
                date: format.dateTime(e.openAt, { dateStyle: 'long', timeStyle: 'short' }),
              })}
            </p>
          ) : null}
          {e.closeAt ? (
            <p>
              {t('info.closes', {
                date: format.dateTime(e.closeAt, { dateStyle: 'long', timeStyle: 'short' }),
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {o.grade !== null ? (
        <Alert variant="success" className="text-base font-medium">
          {t('yourGrade', { grade: fmt(o.grade), max: o.gradeMax })}
        </Alert>
      ) : o.pendingGrade ? (
        <Alert>{t('pendingGrade')}</Alert>
      ) : null}
      {attempts.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('attempt', { n: '' }).trim()}</Th>
              <Th>{t('state.FINISHED')}</Th>
              <Th>{t('grade')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {attempts.map((x) => {
              const g = x.grade;
              return (
                <Tr key={x.id}>
                  <Td>{x.attemptNumber}</Td>
                  <Td>
                    <Badge variant={x.state === 'FINISHED' ? 'success' : 'warning'}>
                      {t(`state.${x.state}`)}
                    </Badge>
                    {x.finishedAt ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {format.dateTime(x.finishedAt, { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                    ) : null}
                  </Td>
                  <Td className="tabular-nums">
                    {x.state !== 'FINISHED'
                      ? '—'
                      : x.needsManualGrading
                        ? t('needsGrading')
                        : g !== null
                          ? `${fmt(g)} / ${a.settings.gradeMax}`
                          : '—'}
                  </Td>
                  <Td className="text-right">
                    {x.reviewable ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`${base(a)}?review=${x.id}`}>{t('review')}</Link>
                      </Button>
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      ) : null}
      {!o.canAttempt ? null : !slotCount ? (
        <Alert variant="warning">{t('empty')}</Alert>
      ) : !o.networkAllowed ? (
        <Alert variant="warning">{t('access.networkBlocked')}</Alert>
      ) : o.inProgressAttemptId ? (
        <Button asChild size="lg" className="w-fit">
          <Link href={`${base(a)}?attempt=${o.inProgressAttemptId}`}>{t('continue')}</Link>
        </Button>
      ) : o.closedReason ? (
        <Alert variant="warning">{t(o.closedReason)}</Alert>
      ) : o.attemptsLeft === 0 ? (
        <Alert>{t('noAttemptsLeft')}</Alert>
      ) : o.nextAttemptAt ? (
        <Alert>
          {t('access.waitUntil', {
            date: format.dateTime(o.nextAttemptAt, { dateStyle: 'long', timeStyle: 'short' }),
          })}
        </Alert>
      ) : (
        <AttemptActions
          activityId={a.id}
          baseUrl={base(a)}
          label={t('start')}
          requiresPassword={o.requiresPassword}
        />
      )}
    </div>
  );
}

async function AttemptPage({ activity: a, ctx, attemptId }: Props & { attemptId: string }) {
  const t = await getTranslations('mod.quiz');
  const at = await readAttempt(ctx, a, attemptId);
  if (!at) return <Alert variant="destructive">{t('closed')}</Alert>;
  if (at.state !== 'IN_PROGRESS')
    return (
      <ReviewPage
        activity={a}
        ctx={ctx}
        attemptId={attemptId}
        course={{ id: a.courseId, fullName: '', shortName: '' }}
        canManage={false}
        searchParams={{}}
      />
    );
  return (
    <AttemptPlayer
      // page by page: each page is a fresh player with the questions the server sent
      key={at.navMethod === 'sequential' ? at.currentPage : 'all'}
      activityId={a.id}
      attemptId={at.id}
      questions={at.questions}
      navMethod={at.navMethod}
      currentPage={at.currentPage}
      pages={at.pages}
      navigation={at.navigation}
      dueAt={at.dueAt?.toISOString() ?? null}
      serverNow={at.serverNow.getTime()}
      backUrl={base(a)}
      reviewUrl={`${base(a)}?review=${at.id}`}
    />
  );
}

async function ReviewPage({ activity: a, ctx, attemptId }: Props & { attemptId: string }) {
  const [t, format] = await Promise.all([getTranslations('mod.quiz'), getFormatter()]);
  const r = await readReview(ctx, a, attemptId);
  // No review (answers, feedback, verdicts) while the student can still change answers.
  if (!r || r === 'inProgress') return <Alert variant="destructive">{t('closed')}</Alert>;
  const { attempt: at, teacher, showMarks } = r;
  const canGrade = await ctx.perm.can('mod.quiz:grade', a.id);
  const tf = (v: string) => (v === 'true' ? t('trueLabel') : v === 'false' ? t('falseLabel') : v);
  return (
    <div className="grid max-w-3xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={teacher ? `${base(a)}?tab=results` : base(a)}>← {t('backToQuiz')}</Link>
        </Button>
        <span className="text-sm text-muted-foreground">
          {teacher && at.userName ? `${at.userName} · ` : ''}
          {t('attempt', { n: at.attemptNumber })}
          {at.finishedAt
            ? ` · ${format.dateTime(at.finishedAt, { dateStyle: 'medium', timeStyle: 'short' })}`
            : ''}
        </span>
      </div>
      {showMarks && r.grade !== null ? (
        <Alert variant={r.pendingGrade ? 'info' : 'success'} className="font-medium">
          {r.pendingGrade
            ? t('pendingGrade')
            : t('yourGrade', { grade: fmt(r.grade), max: r.gradeMax })}
        </Alert>
      ) : null}
      {r.questions.map((qa) => {
        const verdict = qa.verdict;
        const answer = qa.answerText;
        return (
          <Card
            key={qa.id}
            className={cn(
              verdict === 'correct' && 'border-success/50',
              verdict === 'incorrect' && 'border-destructive/40',
              verdict === 'partial' && 'border-warning/50',
            )}
          >
            <CardHeader className="flex-row items-start justify-between gap-2">
              <CardTitle>{t('question', { n: qa.slot })}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                {verdict ? (
                  <Badge
                    variant={
                      verdict === 'correct'
                        ? 'success'
                        : verdict === 'incorrect'
                          ? 'destructive'
                          : 'warning'
                    }
                  >
                    {t(verdict)}
                  </Badge>
                ) : null}
                {showMarks && qa.maxMark > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('marks', {
                      mark: qa.mark === null ? '—' : fmt(qa.mark),
                      max: fmt(qa.maxMark),
                    })}
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div
                className="prose-content"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on save; gaps become blanks
                dangerouslySetInnerHTML={{
                  __html: qa.gapPlaces || qa.clozeParts ? blankGaps(qa.text) : qa.text,
                }}
              />
              {typeDef(qa.type).grading !== 'none' ? (
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p className="text-xs text-muted-foreground">{t('yourAnswer')}</p>
                  {typeDef(qa.type).richText && answer ? (
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: essay HTML is sanitised on save
                    <div className="prose-content" dangerouslySetInnerHTML={{ __html: answer }} />
                  ) : (
                    <p>{answer ? tf(answer) : t('notAnswered')}</p>
                  )}
                </div>
              ) : null}
              {qa.partScores?.length ? (
                <div className="grid gap-1 text-sm">
                  <p className="text-xs font-medium text-muted-foreground">{t('order.scores')}</p>
                  <ol className="grid gap-1">
                    {qa.partScores.map((p, i) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: positions of one fixed answer
                        key={i}
                        className="flex items-center justify-between gap-3 rounded-md bg-muted px-2 py-1"
                      >
                        <span className="min-w-0 break-words">{p.text}</span>
                        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                          {p.fraction === null ? '—' : `${Math.round(p.fraction * 100)}%`}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              {qa.answerFeedback.length ? (
                <div className="grid gap-1 text-sm">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('behaviours.answerFeedback')}
                  </p>
                  {qa.answerFeedback.map((html) => (
                    <div
                      key={html}
                      className="prose-content"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on save
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  ))}
                </div>
              ) : null}
              {qa.correctAnswerText && verdict !== 'correct' ? (
                <p className="text-sm text-success">
                  {t('correctAnswer', { answer: tf(qa.correctAnswerText) })}
                </p>
              ) : null}
              {qa.generalFeedback ? (
                <div className="text-sm">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('generalFeedback')}
                  </p>
                  <div
                    className="prose-content"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on save
                    dangerouslySetInnerHTML={{ __html: qa.generalFeedback }}
                  />
                </div>
              ) : null}
              {qa.comment ? (
                <div className="text-sm">
                  <p className="text-xs font-medium text-muted-foreground">{t('teacherComment')}</p>
                  {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on save */}
                  <div className="prose-content" dangerouslySetInnerHTML={{ __html: qa.comment }} />
                </div>
              ) : null}
              {qa.history?.length ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    {t('history.title')}
                  </summary>
                  <div className="mt-2">
                    <Table>
                      <THead>
                        <Tr>
                          <Th>{t('history.step')}</Th>
                          <Th>{t('history.time')}</Th>
                          <Th>{t('history.action')}</Th>
                          <Th>{t('history.state')}</Th>
                          <Th>{t('history.grade')}</Th>
                        </Tr>
                      </THead>
                      <TBody>
                        {qa.history.map((s) => (
                          <Tr key={s.seq}>
                            <Td className="tabular-nums">{s.seq}</Td>
                            <Td className="whitespace-nowrap text-xs">
                              {format.dateTime(s.at, { dateStyle: 'short', timeStyle: 'medium' })}
                            </Td>
                            <Td>
                              {t(`history.kinds.${s.kind}`, { name: s.userName ?? '—' })}
                              {s.answerText ? (
                                <span className="block text-xs text-muted-foreground">
                                  {typeDef(qa.type).richText
                                    ? t('history.answerSaved')
                                    : tf(s.answerText)}
                                </span>
                              ) : null}
                            </Td>
                            <Td className="text-xs">{t(`history.states.${s.state}`)}</Td>
                            <Td className="tabular-nums">
                              {s.fraction === null ? '—' : fmt(s.fraction * qa.maxMark)}
                            </Td>
                          </Tr>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                </details>
              ) : null}
              {canGrade && typeDef(qa.type).grading === 'manual' && at.state === 'FINISHED' ? (
                <GradeQuestionForm
                  activityId={a.id}
                  questionAttemptId={qa.id}
                  max={qa.maxMark}
                  mark={qa.mark}
                />
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

async function TeacherView(props: Props) {
  const { activity: a, ctx, searchParams } = props;
  const t = await getTranslations('mod.quiz');
  const tab = ['edit', 'results', 'grading', 'overrides'].includes(searchParams.tab ?? '')
    ? searchParams.tab!
    : 'overview';
  const [canEdit, canOverride] = await Promise.all([
    ctx.perm.can('course:manageactivities', a.courseId),
    ctx.perm.can('mod.quiz:manageoverrides', a.id),
  ]);
  const tabs = [
    'overview',
    ...(canEdit ? ['edit'] : []),
    'results',
    'grading',
    ...(canOverride ? ['overrides'] : []),
  ];
  return (
    <div className="grid gap-5">
      <nav className="flex flex-wrap gap-1" aria-label={t('tabs.overview')}>
        {tabs.map((k) => (
          <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
            <Link
              href={k === 'overview' ? base(a) : `${base(a)}?tab=${k}`}
              aria-current={tab === k ? 'page' : undefined}
            >
              {t(`tabs.${k}` as 'tabs.overview')}
            </Link>
          </Button>
        ))}
      </nav>
      {tab === 'edit' && canEdit ? (
        <EditTab {...props} />
      ) : tab === 'results' ? (
        <ResultsTab {...props} />
      ) : tab === 'grading' ? (
        <GradingTab {...props} />
      ) : tab === 'overrides' && canOverride ? (
        <OverridesTab {...props} />
      ) : (
        <OverviewTab {...props} />
      )}
    </div>
  );
}

async function OverridesTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.quiz'), getFormatter()]);
  const [overrides, users, groups] = await Promise.all([
    ctx.db.quizOverride.findMany({
      where: { activityId: a.id },
      include: { group: { select: { name: true } } },
    }),
    ctx.db.user.findMany({
      where: { deletedAt: null, enrolments: { some: { courseId: a.courseId } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, name: true },
    }),
    ctx.db.group.findMany({
      where: { courseId: a.courseId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  const when = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const nameOf = (o: (typeof overrides)[number]) =>
    o.group
      ? t('overrides.group', { name: o.group.name })
      : (users.find((u) => u.id === o.userId)?.name ?? '—');
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      {overrides.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('overrides.who')}</Th>
              <Th>{t('overrides.openAt')}</Th>
              <Th>{t('overrides.closeAt')}</Th>
              <Th>{t('overrides.timeLimit')}</Th>
              <Th>{t('overrides.attempts')}</Th>
              <Th>{t('access.password')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {overrides.map((o) => (
              <Tr key={o.id}>
                <Td className="font-medium">{nameOf(o)}</Td>
                <Td className="text-sm">{when(o.openAt)}</Td>
                <Td className="text-sm">{when(o.closeAt)}</Td>
                <Td className="tabular-nums">
                  {o.timeLimitSec === null ? '—' : Math.round(o.timeLimitSec / 60)}
                </Td>
                <Td className="tabular-nums">{o.attempts ?? '—'}</Td>
                <Td className="text-sm">
                  {o.password === null
                    ? '—'
                    : o.password === ''
                      ? t('overrides.noPassword')
                      : t('overrides.ownPassword')}
                </Td>
                <Td className="text-right">
                  <DeleteOverrideButton activityId={a.id} id={o.id} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <EmptyState title={t('overrides.empty')} />
      )}
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{t('overrides.new')}</CardTitle>
        </CardHeader>
        <CardContent>
          <OverrideForm activityId={a.id} users={users} groups={groups} />
        </CardContent>
      </Card>
    </div>
  );
}

async function OverviewTab({ activity: a, ctx }: Props) {
  const t = await getTranslations('mod.quiz');
  const [slots, finished, item] = await Promise.all([
    ctx.db.quizSlot.count({ where: { activityId: a.id } }),
    ctx.db.quizAttempt.count({ where: { activityId: a.id, preview: false, state: 'FINISHED' } }),
    ctx.db.gradeItem.findFirst({ where: { activityId: a.id } }),
  ]);
  const avg = item
    ? await ctx.db.grade.aggregate({
        where: { gradeItemId: item.id, finalGrade: { not: null } },
        _avg: { finalGrade: true },
      })
    : null;
  const toGrade = await ctx.db.quizAttempt.count({
    where: {
      activityId: a.id,
      needsManualGrading: true,
      preview: false,
      ...(await attemptsSeenBy(ctx, a)),
    },
  });
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          [t('info.questions', { n: '' }).replace(/[:\s]+$/, ''), slots],
          [t('finishedCount'), finished],
          [
            t('average'),
            avg?._avg.finalGrade
              ? `${fmt(Number(avg._avg.finalGrade))} / ${a.settings.gradeMax}`
              : '—',
          ],
          [t('needsGrading'), toGrade],
        ].map(([k, v]) => (
          <Card key={String(k)}>
            <CardContent className="pt-5">
              <p className="text-sm text-muted-foreground">{k}</p>
              <p className="text-2xl font-semibold tabular-nums">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {slots ? (
        <AttemptActions
          activityId={a.id}
          baseUrl={base(a)}
          label={t('preview')}
          preview
          requiresPassword={!!a.settings.password}
        />
      ) : (
        <EmptyState title={t('empty')} />
      )}
    </div>
  );
}

async function EditTab({ activity: a, ctx }: Props) {
  const t = await getTranslations('mod.quiz');
  const [slots, questions, categories, attempts] = await Promise.all([
    ctx.db.quizSlot.findMany({
      where: { activityId: a.id },
      orderBy: { slot: 'asc' },
      include: { question: true, category: true },
    }),
    ctx.db.question.findMany({
      where: { category: { contextId: a.courseId }, status: 'READY' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, type: true, categoryId: true },
    }),
    ctx.db.questionCategory.findMany({
      where: { contextId: a.courseId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { questions: true } } },
    }),
    ctx.db.quizAttempt.count({ where: { activityId: a.id, preview: false } }),
  ]);
  return (
    <div className="grid gap-4">
      {attempts ? <Alert variant="warning">{t('locked')}</Alert> : null}
      <SlotEditor
        activityId={a.id}
        locked={attempts > 0}
        bankUrl={`/course/${a.courseId}/question-bank`}
        slots={slots.map((s) => ({
          slot: s.slot,
          page: s.page,
          label:
            s.kind === 'RANDOM'
              ? t('randomFrom', { category: s.category?.name || '—' })
              : (s.question?.name ?? '—'),
          type: s.question?.type ?? 'RANDOM',
          maxMark: Number(s.maxMark),
        }))}
        questions={questions.filter((q) => !slots.some((s) => s.questionId === q.id))}
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name || '—',
          count: c._count.questions,
        }))}
      />
    </div>
  );
}

async function ResultsTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.quiz'), getFormatter()]);
  const attempts = await ctx.db.quizAttempt.findMany({
    where: { activityId: a.id, preview: false, ...(await attemptsSeenBy(ctx, a)) },
    orderBy: [{ user: { lastName: 'asc' } }, { attemptNumber: 'asc' }],
    include: {
      user: { select: { name: true } },
      questions: { select: { maxMark: true, fraction: true, slot: true } },
    },
  });
  if (!attempts.length) return <EmptyState title={t('noAttempts')} />;
  const canRegrade = await ctx.perm.can('mod.quiz:grade', a.id);
  const slots = [...new Set(attempts.flatMap((x) => x.questions.map((q) => q.slot)))].sort(
    (x, y) => x - y,
  );
  const facility = slots.map((s) => {
    const fr = attempts
      .filter((x) => x.state === 'FINISHED')
      .flatMap((x) => x.questions.filter((q) => q.slot === s && q.fraction !== null))
      .map((q) => Number(q.fraction));
    return fr.length ? Math.round((fr.reduce((p, c) => p + c, 0) / fr.length) * 100) : null;
  });
  return (
    <div className="grid gap-3">
      {canRegrade ? (
        <RegradePanel
          activityId={a.id}
          gradeMax={a.settings.gradeMax}
          names={Object.fromEntries(attempts.map((x) => [x.userId, x.user.name]))}
        />
      ) : null}
      <Table>
        <THead>
          <Tr>
            <Th>{t('student')}</Th>
            <Th>{t('attempt', { n: '' }).trim()}</Th>
            <Th>{t('started')}</Th>
            <Th>{t('duration')}</Th>
            <Th>{t('grade')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {attempts.map((x) => {
            const max = sumMaxMarks(x.questions);
            const g =
              x.sumGrades !== null && max
                ? (Number(x.sumGrades) / max) * a.settings.gradeMax
                : null;
            const mins = x.finishedAt
              ? Math.round((x.finishedAt.getTime() - x.startedAt.getTime()) / 60000)
              : null;
            return (
              <Tr key={x.id}>
                <Td className="font-medium">{x.user.name}</Td>
                <Td>{x.attemptNumber}</Td>
                <Td className="text-sm text-muted-foreground">
                  {format.dateTime(x.startedAt, { dateStyle: 'short', timeStyle: 'short' })}
                </Td>
                <Td className="text-sm">{mins === null ? t(`state.${x.state}`) : `${mins} min`}</Td>
                <Td className="tabular-nums">
                  {x.needsManualGrading ? (
                    <Badge variant="warning">{t('needsGrading')}</Badge>
                  ) : g === null ? (
                    '—'
                  ) : (
                    `${fmt(g)} / ${a.settings.gradeMax}`
                  )}
                </Td>
                <Td className="text-right">
                  {x.state === 'FINISHED' ? (
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`${base(a)}?review=${x.id}`}>{t('review')}</Link>
                    </Button>
                  ) : null}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      <Card>
        <CardHeader>
          <CardTitle>{t('facility')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {slots.map((s, i) => (
            <span
              key={s}
              className="rounded-md border border-border px-2 py-1 text-sm tabular-nums"
            >
              {t('question', { n: s })}: {facility[i] === null ? '—' : `${facility[i]}%`}
            </span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

async function GradingTab({ activity: a, ctx }: Props) {
  const t = await getTranslations('mod.quiz');
  const pending = await ctx.db.quizAttempt.findMany({
    where: {
      activityId: a.id,
      needsManualGrading: true,
      preview: false,
      state: 'FINISHED',
      ...(await attemptsSeenBy(ctx, a)),
    },
    include: { user: { select: { name: true } } },
    orderBy: { finishedAt: 'asc' },
  });
  if (!pending.length) return <EmptyState title={t('nothingToGrade')} />;
  return (
    <ul className="grid gap-2">
      {pending.map((x) => (
        <li key={x.id}>
          <Card>
            <CardContent className="flex items-center justify-between pt-4">
              <span>
                {x.user.name} · {t('attempt', { n: x.attemptNumber })}
              </span>
              <Button asChild size="sm">
                <Link href={`${base(a)}?review=${x.id}`}>{t('gradeQuestion')}</Link>
              </Button>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
