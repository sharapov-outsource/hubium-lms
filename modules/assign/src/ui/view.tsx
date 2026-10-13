import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '@hubium/ui';
import { Download, FileIcon } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  type AssignSettingsT,
  assignGradeText,
  assignScale,
  canSubmitNow,
  effectiveDates,
} from '../server.ts';
import { ExtensionForm, GradeForm, SubmissionForm, WithdrawButton } from './client.tsx';

type Props = ViewProps<AssignSettingsT>;

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
      };
  const now = new Date();
  const rows: [string, Date][] = [];
  if (d.openAt) rows.push([t('opens'), d.openAt]);
  if (d.dueAt) rows.push([t('due'), d.dueAt]);
  if (d.cutoffAt && d.cutoffAt.getTime() !== d.dueAt?.getTime())
    rows.push([t('cutoff'), d.cutoffAt]);
  if (!rows.length) return null;
  return (
    <dl className="grid gap-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap gap-2">
          <dt className="text-muted-foreground">{k}:</dt>
          <dd>{format.dateTime(v, { dateStyle: 'long', timeStyle: 'short' })}</dd>
        </div>
      ))}
      {d.dueAt ? (
        <div className={d.dueAt < now ? 'text-destructive' : 'text-muted-foreground'}>
          {d.dueAt < now
            ? t('overdue', { time: format.relativeTime(d.dueAt, now) })
            : t('timeLeft', { time: format.relativeTime(d.dueAt, now) })}
        </div>
      ) : null}
      {d.extended ? (
        <Badge variant="accent" className="w-fit">
          {t('extended')}
        </Badge>
      ) : null}
    </dl>
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
  const scale = await assignScale(ctx.db, a);
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  if (ctx.actor.kind !== 'user') return null;
  const userId = ctx.actor.userId;
  const canSubmit = await ctx.perm.can('mod.assign:submit', a.id);
  const sub = await ctx.db.assignSubmission.findFirst({
    where: { activityId: a.id, userId, latest: true },
  });
  const files = sub ? await ctx.files.list(a.id, 'submission', sub.id) : [];
  const grade = sub
    ? await ctx.db.assignGrade.findUnique({
        where: {
          activityId_userId_attemptNumber: {
            activityId: a.id,
            userId,
            attemptNumber: sub.attemptNumber,
          },
        },
      })
    : null;
  const lastGrade =
    grade ??
    (await ctx.db.assignGrade.findFirst({
      where: { activityId: a.id, userId },
      orderBy: { attemptNumber: 'desc' },
    }));
  const grader = lastGrade?.graderId
    ? await ctx.db.user.findUnique({ where: { id: lastGrade.graderId }, select: { name: true } })
    : null;
  const feedbackFiles = lastGrade
    ? (await ctx.files.list(a.id, 'feedback', userId)).filter(
        (f) => f.path === `/${lastGrade.attemptNumber}/`,
      )
    : [];
  const dates = await effectiveDates(ctx.db, a, userId);
  const window = canSubmitNow(dates, ctx.now);
  const status = sub?.status ?? 'NEW';
  const editable = canSubmit && window.ok && status !== 'SUBMITTED';
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
            {sub && sub.attemptNumber > 0 ? (
              <Badge>{t('attempt', { n: sub.attemptNumber + 1 })}</Badge>
            ) : null}
          </div>
          {!window.ok && canSubmit && status !== 'SUBMITTED' ? (
            <Alert variant="warning">{t(window.reason!)}</Alert>
          ) : null}
        </CardContent>
      </Card>
      {lastGrade ? (
        <Card className="border-success/40">
          <CardHeader>
            <CardTitle>
              {t('grade')}:{' '}
              {lastGrade.grade === null
                ? '—'
                : assignGradeText(Number(lastGrade.grade), scale, a.settings.gradeMax, (max) =>
                    t('outOf', { max }),
                  )}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {t('gradedBy', {
                name: grader?.name ?? '—',
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
        />
      ) : sub && (sub.onlineText || files.length) ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('yourText')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {sub.onlineText ? <RichText html={sub.onlineText} /> : null}
            <FileList files={files} />
            {status === 'SUBMITTED' && window.ok && !grade ? (
              <WithdrawButton activityId={a.id} />
            ) : null}
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

async function TeacherOverview({ activity: a, ctx, searchParams }: Props) {
  const scale = await assignScale(ctx.db, a);
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const users = await learners(ctx, a.id);
  const [subs, grades] = await Promise.all([
    ctx.db.assignSubmission.findMany({
      where: { activityId: a.id, latest: true, userId: { in: users.map((u) => u.id) } },
    }),
    ctx.db.assignGrade.findMany({
      where: { activityId: a.id, userId: { in: users.map((u) => u.id) } },
    }),
  ]);
  const rows = users.map((u) => {
    const s = subs.find((x) => x.userId === u.id);
    const g = grades
      .filter((x) => x.userId === u.id)
      .sort((x, y) => y.attemptNumber - x.attemptNumber)[0];
    const needs = s?.status === 'SUBMITTED' && !(g && g.attemptNumber === s.attemptNumber);
    return { u, s, g, needs };
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
            <Th>{t('status')}</Th>
            <Th>{t('lastModified')}</Th>
            <Th>{t('grade')}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {shown.map(({ u, s, g, needs }) => (
            <Tr key={u.id}>
              <Td className="font-medium">{u.name}</Td>
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
                    : `${Number(g.grade)} / ${a.settings.gradeMax}`
                  : '—'}
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

async function GradingPanel({ activity: a, ctx, userId }: Props & { userId: string }) {
  const scale = await assignScale(ctx.db, a);
  const [t, format] = await Promise.all([getTranslations('mod.assign'), getFormatter()]);
  const users = await learners(ctx, a.id);
  const user = users.find((u) => u.id === userId);
  const base = `/course/${a.courseId}/a/${a.id}`;
  if (!user) return <Alert variant="warning">{t('noSubmission')}</Alert>;
  const sub = await ctx.db.assignSubmission.findFirst({
    where: { activityId: a.id, userId, latest: true },
  });
  const files = sub ? await ctx.files.list(a.id, 'submission', sub.id) : [];
  const grade = await ctx.db.assignGrade.findFirst({
    where: { activityId: a.id, userId },
    orderBy: { attemptNumber: 'desc' },
  });
  const current = grade && sub && grade.attemptNumber === sub.attemptNumber ? grade : null;
  const override = await ctx.db.assignOverride.findUnique({
    where: { activityId_userId: { activityId: a.id, userId } },
  });
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
      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Badge variant={sub?.status === 'SUBMITTED' ? 'success' : 'neutral'}>
                {t(`statuses.${sub?.status ?? 'NEW'}`)}
              </Badge>
              {sub && sub.attemptNumber > 0 ? (
                <Badge>{t('attempt', { n: sub.attemptNumber + 1 })}</Badge>
              ) : null}
              {sub?.submittedAt ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {format.dateTime(sub.submittedAt, { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
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
              dueAt={override?.dueAt?.toISOString() ?? a.settings.dueAt ?? null}
              hasOverride={!!override}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
