import { RichText } from '@hubium/editor/client';
import { groupsWhere } from '@hubium/module-sdk/groups';
import type { ViewProps } from '@hubium/module-sdk/ui';
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
import { CheckCircle2, Circle, Download, FileIcon } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  type AssignSettingsT,
  applyPenalty,
  assignGradeText,
  assignScale,
  effectiveDates,
  latestFor,
  readAssignStatus,
  teamMembers,
  teamOf,
} from '../server.ts';
import {
  ExtensionForm,
  GradeForm,
  OverrideActions,
  OverrideForm,
  SubmissionForm,
  WithdrawButton,
} from './client.tsx';

type Props = ViewProps<AssignSettingsT>;

const DAY = 86_400;
/** Started days late, as the penalty counts them. */
const daysLate = (seconds: number) => Math.ceil(seconds / DAY);

async function Dates({
  a,
  userId,
  db,
}: {
  a: Props['activity'];
  userId?: string;
  db: Props['ctx']['db'];
}) {
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const d = userId
    ? await effectiveDates(db, a, userId)
    : {
        openAt: a.settings.openAt ? new Date(a.settings.openAt) : null,
        dueAt: a.settings.dueAt ? new Date(a.settings.dueAt) : null,
        cutoffAt: a.settings.cutoffAt ? new Date(a.settings.cutoffAt) : null,
        extended: false,
        source: null,
      };
  const now = new Date();
  const rows: [string, Date][] = [];
  if (d.openAt) rows.push([t('opens'), d.openAt]);
  if (d.dueAt) rows.push([t('due'), d.dueAt]);
  if (d.cutoffAt && d.cutoffAt.getTime() !== d.dueAt?.getTime())
    rows.push([t('cutoff'), d.cutoffAt]);
  if (!rows.length) return null;
  // only term and value pairs go in the list; the notes about it follow it
  return (
    <div className="grid gap-1 text-sm">
      <dl className="grid gap-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-2">
            <dt className="text-muted-foreground">{k}:</dt>
            <dd>{format.dateTime(v, { dateStyle: 'long', timeStyle: 'short' })}</dd>
          </div>
        ))}
      </dl>
      {d.dueAt ? (
        <div className={d.dueAt < now ? 'text-destructive' : 'text-muted-foreground'}>
          {d.dueAt < now
            ? t('overdue', { time: format.relativeTime(d.dueAt, now) })
            : t('timeLeft', { time: format.relativeTime(d.dueAt, now) })}
        </div>
      ) : null}
      {d.extended ? (
        <Badge variant="accent" className="w-fit">
          {d.source === 'group' ? t('groupDates') : t('extended')}
        </Badge>
      ) : null}
    </div>
  );
}

export async function AssignView(props: Props) {
  const { activity: a, ctx } = props;
  const canGrade = await ctx.perm.can('mod.assign:grade', a.id);
  if (canGrade)
    return props.searchParams.grade ? (
      <GradingPanel {...props} userId={props.searchParams.grade} />
    ) : (
      <TeacherOverview {...props} />
    );
  return <StudentView {...props} />;
}

async function StudentView({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  if (ctx.actor.kind !== 'user') return null;
  const userId = ctx.actor.userId;
  const st = await readAssignStatus(ctx, a);
  const { canSubmit, status, editable, scale } = st;
  const sub = st.submission;
  const files = sub?.files ?? [];
  const lastGrade = st.grade;
  const feedbackFiles = lastGrade?.feedbackFiles ?? [];
  const late = st.late.seconds > 0;
  return (
    <div className="grid max-w-3xl gap-5">
      <Card>
        <CardContent className="grid gap-3 pt-5">
          <Dates a={a} userId={userId} db={ctx.db} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('status')}:</span>
            <Badge
              variant={
                status === 'SUBMITTED' ? 'success' : status === 'DRAFT' ? 'warning' : 'neutral'
              }
            >
              {t(`statuses.${status}`)}
            </Badge>
            {sub && st.attemptNumber > 0 ? (
              <Badge>{t('attempt', { n: st.attemptNumber + 1 })}</Badge>
            ) : null}
          </div>
          {st.blocked ? <Alert variant="warning">{t(`team.blocked.${st.blocked}`)}</Alert> : null}
          {st.window.reason && canSubmit && status !== 'SUBMITTED' ? (
            <Alert variant="warning">{t(st.window.reason)}</Alert>
          ) : null}
          {late && st.window.open && !st.blocked ? (
            <Alert variant="warning">
              {status === 'SUBMITTED'
                ? t('penalty.submittedLate', {
                    days: daysLate(st.late.seconds),
                    percent: st.late.penalty,
                  })
                : t('penalty.lateNow', {
                    days: daysLate(st.late.seconds),
                    percent: st.late.penalty,
                  })}
            </Alert>
          ) : null}
          {st.waitingForTeam ? <Alert variant="info">{t('team.waiting')}</Alert> : null}
          {st.statementAcceptedAt ? (
            <p className="text-xs text-muted-foreground">
              {t('statementAccepted', {
                date: format.dateTime(st.statementAcceptedAt, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {st.team ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('team.title')}: {st.team.name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1.5 text-sm">
              {st.team.members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  {m.submitted ? (
                    <CheckCircle2 className="size-4 text-success" aria-hidden />
                  ) : (
                    <Circle className="size-4 text-muted-foreground" aria-hidden />
                  )}
                  <span>{m.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {m.submitted ? t('team.memberSubmitted') : t('team.memberNotSubmitted')}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {lastGrade ? (
        <Card className="border-success/40">
          <CardHeader>
            <CardTitle>
              {t('grade')}:{' '}
              {lastGrade.final === null
                ? '—'
                : assignGradeText(lastGrade.final, scale, a.settings.gradeMax, (max) =>
                    t('outOf', { max }),
                  )}
            </CardTitle>
            {lastGrade.penalty && lastGrade.value !== null ? (
              <p className="text-sm text-muted-foreground">
                {t('penalty.breakdown', {
                  grade: lastGrade.value,
                  percent: lastGrade.penalty,
                  days: daysLate(lastGrade.lateSeconds ?? 0),
                  final: lastGrade.final ?? 0,
                })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t('gradedBy', {
                name: lastGrade.graderName ?? '—',
                date: format.dateTime(lastGrade.gradedAt, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          </CardHeader>
          {lastGrade.feedback || feedbackFiles.length ? (
            <CardContent className="grid gap-2">
              {lastGrade.feedback ? <RichText html={lastGrade.feedback} /> : null}
              <FileList files={feedbackFiles} />
            </CardContent>
          ) : null}
        </Card>
      ) : null}
      {editable ? (
        <SubmissionForm
          activityId={a.id}
          allowText={a.settings.allowText}
          allowFiles={a.settings.allowFiles}
          maxFiles={a.settings.maxFiles}
          submitButton={a.settings.submitButton}
          text={sub?.onlineText ?? ''}
          files={files.map((f) => ({ id: f.id, name: f.name, url: f.url }))}
          courseId={a.courseId}
          requireStatement={st.requireStatement}
          teamName={st.team?.name ?? null}
        />
      ) : sub && (sub.onlineText || files.length) ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {st.team ? t('team.work', { name: st.team.name }) : t('yourText')}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {sub.onlineText ? <RichText html={sub.onlineText} /> : null}
            <FileList files={files} />
            {st.canWithdraw ? <WithdrawButton activityId={a.id} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function FileList({ files }: { files: { id: string; name: string; url: string }[] }) {
  if (!files.length) return null;
  return (
    <ul className="grid gap-1">
      {files.map((f) => (
        <li key={f.id}>
          <a
            href={f.url}
            className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
          >
            <FileIcon className="size-4" aria-hidden />
            {f.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

async function learners(ctx: Props['ctx'], activityId: string) {
  const ids = await ctx.perm.usersWithCap('mod.assign:submit', activityId);
  return ctx.db.user.findMany({
    where: { id: { in: ids }, deletedAt: null },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, name: true },
  });
}

async function TeacherOverview(props: Props) {
  const { activity: a, ctx, searchParams } = props;
  const t = await getTranslations('mod.assign');
  const canOverride = await ctx.perm.can('mod.assign:manageoverrides', a.id);
  const tab = canOverride && searchParams.tab === 'overrides' ? 'overrides' : 'submissions';
  const base = `/course/${a.courseId}/a/${a.id}`;
  return (
    <div className="grid gap-5">
      {canOverride ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('tabs.label')}>
          {(['submissions', 'overrides'] as const).map((k) => (
            <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
              <Link
                href={k === 'submissions' ? base : `${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
              >
                {t(`tabs.${k}`)}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
      {tab === 'overrides' ? <OverridesTab {...props} /> : <Submissions {...props} />}
    </div>
  );
}

async function Submissions({ activity: a, ctx, searchParams }: Props) {
  const scale = await assignScale(ctx.db, a);
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const users = await learners(ctx, a.id);
  const team = a.settings.teamSubmission;
  // each student's team: the one group of the assignment's groups they are in
  const memberships = team
    ? await ctx.db.groupMember.findMany({
        where: { userId: { in: users.map((u) => u.id) }, group: groupsWhere(a) },
        include: { group: { select: { id: true, name: true } } },
      })
    : [];
  const groupOf = new Map<string, { id: string; name: string } | null>();
  for (const u of users) {
    const mine = memberships.filter((m) => m.userId === u.id);
    groupOf.set(u.id, mine.length === 1 ? mine[0]!.group : null);
  }
  const [subs, grades] = await Promise.all([
    ctx.db.assignSubmission.findMany({
      where: {
        activityId: a.id,
        latest: true,
        OR: [
          { userId: { in: users.map((u) => u.id) } },
          { groupId: { in: memberships.map((m) => m.groupId) } },
        ],
      },
    }),
    ctx.db.assignGrade.findMany({
      where: { activityId: a.id, userId: { in: users.map((u) => u.id) } },
    }),
  ]);
  const rows = users.map((u) => {
    const g0 = groupOf.get(u.id);
    const s = g0 ? subs.find((x) => x.groupId === g0.id) : subs.find((x) => x.userId === u.id);
    const g = grades
      .filter((x) => x.userId === u.id)
      .sort((x, y) => y.attemptNumber - x.attemptNumber)[0];
    const needs = s?.status === 'SUBMITTED' && !(g && g.attemptNumber === s.attemptNumber);
    return { u, s, g, needs, team: g0 };
  });
  const filter = searchParams.filter;
  const shown = rows.filter((r) =>
    filter === 'needs' ? r.needs : filter === 'none' ? r.s?.status !== 'SUBMITTED' : true,
  );
  const base = `/course/${a.courseId}/a/${a.id}`;
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [t('participants'), rows.length],
          [t('submittedCount'), rows.filter((r) => r.s?.status === 'SUBMITTED').length],
          [t('needsGrading'), rows.filter((r) => r.needs).length],
        ].map(([k, v]) => (
          <Card key={String(k)}>
            <CardContent className="pt-5">
              <p className="text-sm text-muted-foreground">{k}</p>
              <p className="text-2xl font-semibold tabular-nums">{v}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <Dates a={a} db={ctx.db} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex gap-1" aria-label={t('status')}>
          {[
            ['', t('filterAll')],
            ['needs', t('filterNeedsGrading')],
            ['none', t('filterNotSubmitted')],
          ].map(([k, label]) => (
            <Button
              key={k}
              asChild
              size="sm"
              variant={(filter ?? '') === k ? 'secondary' : 'ghost'}
            >
              <Link href={k ? `${base}?filter=${k}` : base}>{label}</Link>
            </Button>
          ))}
        </nav>
        <Button asChild variant="outline" size="sm">
          <a href={`/api/mod/assign/${a.id}/download`}>
            <Download />
            {t('downloadAll')}
          </a>
        </Button>
      </div>
      <Table>
        <THead>
          <Tr>
            <Th>{t('student')}</Th>
            {team ? <Th>{t('team.title')}</Th> : null}
            <Th>{t('status')}</Th>
            <Th>{t('lastModified')}</Th>
            <Th>{t('grade')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {shown.map(({ u, s, g, needs, team: tm }) => (
            <Tr key={u.id}>
              <Td className="font-medium">{u.name}</Td>
              {team ? <Td className="text-sm">{tm?.name ?? '—'}</Td> : null}
              <Td>
                <Badge
                  variant={needs ? 'warning' : s?.status === 'SUBMITTED' ? 'success' : 'neutral'}
                >
                  {needs ? t('needsGrading') : t(`statuses.${s?.status ?? 'NEW'}`)}
                </Badge>
              </Td>
              <Td className="text-sm text-muted-foreground">
                {s ? format.dateTime(s.updatedAt, { dateStyle: 'short', timeStyle: 'short' }) : '—'}
              </Td>
              <Td className="tabular-nums">
                {g?.grade !== null && g?.grade !== undefined
                  ? scale
                    ? (scale[Number(g.grade) - 1] ?? '—')
                    : `${g.penalty ? applyPenalty(Number(g.grade), Number(g.penalty)) : Number(g.grade)} / ${a.settings.gradeMax}`
                  : '—'}
                {g?.penalty ? (
                  <span className="ml-1 text-xs text-warning">−{Number(g.penalty)}%</span>
                ) : null}
              </Td>
              <Td className="text-right">
                <Button asChild size="sm" variant={needs ? 'primary' : 'outline'}>
                  <Link href={`${base}?grade=${u.id}`}>{t('gradeAction')}</Link>
                </Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

async function OverridesTab({ activity: a, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const [overrides, users, groups] = await Promise.all([
    ctx.db.assignOverride.findMany({
      where: { activityId: a.id },
      include: { group: { select: { name: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    learners(ctx, a.id),
    ctx.db.group.findMany({
      where: { courseId: a.courseId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  const groupRows = overrides.filter((o) => o.groupId);
  const userRows = overrides.filter((o) => o.userId);
  const when = (d: Date | null) =>
    d ? format.dateTime(d, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  const nameOf = (o: (typeof overrides)[number]) =>
    o.group
      ? t('overrides.group', { name: o.group.name })
      : (users.find((u) => u.id === o.userId)?.name ?? '—');
  const rows = [...groupRows, ...userRows];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid content-start gap-3">
        {groupRows.length > 1 ? (
          <p className="text-sm text-muted-foreground">{t('overrides.priorityHint')}</p>
        ) : null}
        {rows.length ? (
          <Table>
            <THead>
              <Tr>
                <Th>{t('overrides.who')}</Th>
                <Th>{t('openAt')}</Th>
                <Th>{t('dueAt')}</Th>
                <Th>{t('cutoffAt')}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {rows.map((o) => {
                const i = groupRows.indexOf(o);
                return (
                  <Tr key={o.id}>
                    <Td className="font-medium">{nameOf(o)}</Td>
                    <Td className="text-sm">{when(o.allowSubmissionsFrom)}</Td>
                    <Td className="text-sm">{when(o.dueAt)}</Td>
                    <Td className="text-sm">{when(o.cutoffAt)}</Td>
                    <Td className="text-right">
                      <OverrideActions
                        activityId={a.id}
                        id={o.id}
                        name={nameOf(o)}
                        move={i >= 0 ? { up: i > 0, down: i < groupRows.length - 1 } : undefined}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <EmptyState title={t('overrides.empty')} />
        )}
      </div>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>{t('overrides.add')}</CardTitle>
        </CardHeader>
        <CardContent>
          <OverrideForm activityId={a.id} users={users} groups={groups} />
        </CardContent>
      </Card>
    </div>
  );
}

async function GradingPanel({ activity: a, ctx, userId }: Props & { userId: string }) {
  const scale = await assignScale(ctx.db, a);
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const users = await learners(ctx, a.id);
  const user = users.find((u) => u.id === userId);
  const base = `/course/${a.courseId}/a/${a.id}`;
  if (!user) return <Alert variant="warning">{t('noSubmission')}</Alert>;
  const team = await teamOf(ctx.db, a, userId);
  const sub = await latestFor(ctx.db, a, userId, team);
  const members = team.kind === 'team' ? await teamMembers(ctx, a, team.groupId) : [];
  const files = sub ? await ctx.files.list(a.id, 'submission', sub.id) : [];
  const grade = await ctx.db.assignGrade.findFirst({
    where: { activityId: a.id, userId },
    orderBy: { attemptNumber: 'desc' },
  });
  const current = grade && sub && grade.attemptNumber === sub.attemptNumber ? grade : null;
  const override = await ctx.db.assignOverride.findUnique({
    where: { activityId_userId: { activityId: a.id, userId } },
  });
  const dates = await effectiveDates(ctx.db, a, userId);
  const late =
    sub?.submittedAt && dates.dueAt
      ? Math.max(0, (sub.submittedAt.getTime() - dates.dueAt.getTime()) / 1000)
      : 0;
  const idx = users.findIndex((u) => u.id === userId);
  const next = users[idx + 1];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={base}>← {t('back')}</Link>
        </Button>
        {next ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}?grade=${next.id}`}>
              {t('next')}: {next.name} →
            </Link>
          </Button>
        ) : null}
      </div>
      <h3 className="text-lg font-semibold">{t('gradingTitle', { name: user.name })}</h3>
      {team.kind === 'blocked' ? (
        <Alert variant="warning">{t(`team.teacherBlocked.${team.reason}`)}</Alert>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <Badge variant={sub?.status === 'SUBMITTED' ? 'success' : 'neutral'}>
                {t(`statuses.${sub?.status ?? 'NEW'}`)}
              </Badge>
              {sub && sub.attemptNumber > 0 ? (
                <Badge>{t('attempt', { n: sub.attemptNumber + 1 })}</Badge>
              ) : null}
              {team.kind === 'team' ? <Badge variant="accent">{team.name}</Badge> : null}
              {sub?.submittedAt ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {format.dateTime(sub.submittedAt, { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {late > 0 ? (
              <Alert variant="warning">
                {t('penalty.teacherLate', {
                  days: daysLate(late),
                  percent: scale
                    ? 0
                    : Math.min(
                        a.settings.latePenaltyCap,
                        a.settings.latePenaltyPerDay * daysLate(late),
                      ),
                })}
              </Alert>
            ) : null}
            {sub?.statementAcceptedAt ? (
              <p className="text-xs text-muted-foreground">
                {t('statementAccepted', {
                  date: format.dateTime(sub.statementAcceptedAt, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </p>
            ) : null}
            {members.length ? (
              <p className="text-sm text-muted-foreground">
                {t('team.members', { names: members.map((m) => m.name).join(', ') })}
              </p>
            ) : null}
            {!sub || (!sub.onlineText && !files.length) ? (
              <p className="text-sm text-muted-foreground">{t('noSubmission')}</p>
            ) : null}
            {sub?.onlineText ? <RichText html={sub.onlineText} /> : null}
            <FileList files={files} />
          </CardContent>
        </Card>
        <div className="grid content-start gap-4">
          <GradeForm
            activityId={a.id}
            courseId={a.courseId}
            userId={userId}
            gradeMax={a.settings.gradeMax}
            scale={scale}
            grade={
              current?.grade === null || current?.grade === undefined ? null : Number(current.grade)
            }
            feedback={current?.feedback ?? ''}
            canReopen={a.settings.reopen !== 'none' && !!sub}
            nextUrl={next ? `${base}?grade=${next.id}` : base}
            team={team.kind === 'team' ? { name: team.name, size: members.length } : null}
            ai={
              sub && (sub.onlineText || files.length)
                ? await ctx.ai.status('GRADING_ASSIST', a.courseId)
                : undefined
            }
          />
          {(await ctx.perm.can('mod.assign:grantextension', a.id)) ? (
            <ExtensionForm
              activityId={a.id}
              userId={userId}
              dueAt={override?.dueAt?.toISOString() ?? dates.dueAt?.toISOString() ?? null}
              hasOverride={!!override}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
