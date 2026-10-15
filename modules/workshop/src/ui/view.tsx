import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Button, Card, CardContent, EmptyState } from '@hubium/ui';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { type Filling, phases } from '../engine.ts';
import {
  formOf,
  submissionView,
  type WorkshopSettingsT,
  workshopOverview,
  workshopState,
} from '../server.ts';
import {
  AllocationRow,
  AssessmentForm,
  CalculateGrades,
  FormEditor,
  GradeAssessment,
  GradeSubmission,
  PhaseSwitch,
  RandomAllocation,
  SubmissionForm,
} from './client.tsx';

type Props = ViewProps<WorkshopSettingsT>;
const pct = (v: number | null, max: number) =>
  v === null ? '—' : String(Math.round(v * max) / 100);

export async function WorkshopView(props: Props) {
  const { activity: a, course, ctx, searchParams: sp } = props;
  const t = await getTranslations('mod.workshop');
  const base = `/course/${course.id}/a/${a.id}`;
  const manage = await ctx.perm.can('mod.workshop:manage', a.id);
  const tabs = manage ? (['overview', 'form', 'allocation'] as const) : (['overview'] as const);
  const tab = tabs.find((k) => k === sp.tab) ?? 'overview';
  const page = sp.submission ? (
    <SubmissionPage {...props} id={sp.submission} />
  ) : sp.assess ? (
    <AssessPage {...props} id={sp.assess} />
  ) : sp.edit === '1' ? (
    <EditPage {...props} />
  ) : tab === 'form' ? (
    <FormTab {...props} />
  ) : tab === 'allocation' ? (
    <AllocationTab {...props} />
  ) : (
    <OverviewTab {...props} />
  );
  return (
    <div className="grid gap-5">
      {tabs.length > 1 && !sp.submission && !sp.assess && sp.edit !== '1' ? (
        <nav className="flex flex-wrap gap-1" aria-label={t('tabsLabel')}>
          {tabs.map((k) => (
            <Button key={k} asChild size="sm" variant={tab === k ? 'secondary' : 'ghost'}>
              <Link
                href={k === 'overview' ? base : `${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
              >
                {t(`tabs.${k}`)}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
      {page}
    </div>
  );
}

const Back = ({ href, label }: { href: string; label: string }) => (
  <Link href={href} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
    <ChevronLeft className="size-4" aria-hidden />
    {label}
  </Link>
);

async function OverviewTab({ activity: a, course, ctx }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.workshop'), getFormatter()]);
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;
  const o = await workshopOverview(ctx, a);
  const r = o.rights;
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const dates = [
    ['submissionStart', when(s.submissionStart)],
    ['submissionEnd', when(s.submissionEnd)],
    ['assessmentStart', when(s.assessmentStart)],
    ['assessmentEnd', when(s.assessmentEnd)],
  ].filter(([, v]) => v);
  const submitOpen =
    o.phase === 'submission' &&
    (!s.submissionStart || ctx.now >= new Date(s.submissionStart)) &&
    (!s.submissionEnd || ctx.now <= new Date(s.submissionEnd) || (s.lateSubmissions && !o.mine));
  return (
    <div className="grid max-w-4xl gap-5">
      <section aria-labelledby="ws-phase" className="grid gap-2">
        <h2 id="ws-phase" className="text-sm font-medium text-muted-foreground">
          {t('phase')}
        </h2>
        {r.manage ? (
          <PhaseSwitch activityId={a.id} phase={o.phase} phases={[...phases]} />
        ) : (
          <ol className="flex flex-wrap gap-1 text-sm">
            {phases.map((p) => (
              <li
                key={p}
                aria-current={p === o.phase ? 'step' : undefined}
                className="rounded-full border border-border px-2.5 py-0.5 aria-[current=step]:bg-secondary aria-[current=step]:font-semibold"
              >
                {t(`phases.${p}`)}
              </li>
            ))}
          </ol>
        )}
        {dates.length ? (
          <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            {dates.map(([k, v]) => (
              <span key={k}>{t(`dates.${k}`, { time: v! })}</span>
            ))}
          </p>
        ) : null}
      </section>

      {o.phase === 'submission' && s.instructAuthors ? (
        <Card>
          <CardContent className="grid gap-2 pt-5">
            <h3 className="font-medium">{t('instructAuthors')}</h3>
            <RichText html={s.instructAuthors} />
          </CardContent>
        </Card>
      ) : null}
      {o.phase === 'assessment' && s.instructReviewers ? (
        <Card>
          <CardContent className="grid gap-2 pt-5">
            <h3 className="font-medium">{t('instructReviewers')}</h3>
            <RichText html={s.instructReviewers} />
          </CardContent>
        </Card>
      ) : null}
      {o.phase === 'closed' && s.conclusion ? (
        <Card>
          <CardContent className="grid gap-2 pt-5">
            <h3 className="font-medium">{t('conclusion')}</h3>
            <RichText html={s.conclusion} />
          </CardContent>
        </Card>
      ) : null}

      {r.submit ? (
        <section aria-labelledby="ws-mine" className="grid gap-2">
          <h2 id="ws-mine" className="text-lg font-semibold">
            {t('yourWork')}
          </h2>
          {o.mine ? (
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={`${base}?submission=${o.mine.id}`}
                className="font-medium text-accent hover:underline"
              >
                {o.mine.title}
              </Link>
              {o.mine.late ? <Badge variant="warning">{t('late')}</Badge> : null}
              {submitOpen && !o.mine.late ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={`${base}?edit=1`}>{t('editWork')}</Link>
                </Button>
              ) : null}
            </div>
          ) : submitOpen ? (
            <Button asChild className="justify-self-start">
              <Link href={`${base}?edit=1`}>{t('submitWork')}</Link>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {o.phase === 'setup' ? t('notYet') : t('noWork')}
            </p>
          )}
          {o.phase === 'closed' && o.mine ? (
            <p className="text-sm">
              {t('yourGrade', {
                grade: pct(o.mine.gradeOver ?? o.mine.grade, s.gradeMax),
                max: s.gradeMax,
              })}
            </p>
          ) : null}
        </section>
      ) : null}

      {o.toReview.length ? (
        <section aria-labelledby="ws-review" className="grid gap-2">
          <h2 id="ws-review" className="text-lg font-semibold">
            {t('toAssess')}
          </h2>
          <ul className="grid gap-1">
            {o.toReview.map((x) => (
              <li key={x.assessmentId} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  href={`${base}?assess=${x.assessmentId}`}
                  className="text-accent hover:underline"
                >
                  {x.title}
                </Link>
                {x.author ? <span className="text-muted-foreground">{x.author}</span> : null}
                {x.self ? <Badge variant="neutral">{t('selfAssessment')}</Badge> : null}
                <Badge variant={x.assessed ? 'success' : 'warning'}>
                  {x.assessed ? t('assessedBadge') : t('waitingBadge')}
                </Badge>
              </li>
            ))}
          </ul>
          {o.phase === 'closed' && o.myGradingGrade !== null ? (
            <p className="text-sm">
              {t('yourGradingGrade', {
                grade: pct(o.myGradingGrade, s.gradingGradeMax),
                max: s.gradingGradeMax,
              })}
            </p>
          ) : null}
        </section>
      ) : null}

      {o.published.length ? (
        <section aria-labelledby="ws-published" className="grid gap-2">
          <h2 id="ws-published" className="text-lg font-semibold">
            {t('publishedWorks')}
          </h2>
          <ul className="grid gap-1 text-sm">
            {o.published.map((p) => (
              <li key={p.id}>
                <Link href={`${base}?submission=${p.id}`} className="text-accent hover:underline">
                  {p.title}
                </Link>{' '}
                <span className="text-muted-foreground">{p.author.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {r.viewAll ? (
        <section aria-labelledby="ws-all" className="grid gap-3">
          <h2 id="ws-all" className="text-lg font-semibold">
            {t('submissions', { n: o.all.length })}
          </h2>
          {r.manage && o.phase === 'evaluation' ? (
            <CalculateGrades activityId={a.id} comparison={s.comparison} />
          ) : null}
          {o.all.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="py-2 pr-3 font-medium">{t('author')}</th>
                    <th className="py-2 pr-3 font-medium">{t('work')}</th>
                    <th className="py-2 pr-3 font-medium">{t('received')}</th>
                    <th className="py-2 pr-3 font-medium">{t('gradeFor', { max: s.gradeMax })}</th>
                    <th className="py-2 font-medium">
                      {t('gradingGradeFor', { max: s.gradingGradeMax })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {o.all.map((x) => (
                    <tr key={x.id} className="border-b border-border align-top">
                      <td className="py-2 pr-3">{x.author.name}</td>
                      <td className="py-2 pr-3">
                        <Link
                          href={`${base}?submission=${x.id}`}
                          className="text-accent hover:underline"
                        >
                          {x.title}
                        </Link>
                        {x.late ? (
                          <Badge variant="warning" className="ml-1">
                            {t('late')}
                          </Badge>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <ul>
                          {x.received.map((y) => (
                            <li key={y.id}>
                              {y.reviewer.name}:{' '}
                              {y.grade === null ? '—' : `${Math.round(y.grade)}%`}
                              {y.gradingGrade !== null ? ` (${Math.round(y.gradingGrade)}%)` : ''}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="py-2 pr-3">
                        {pct(x.grade, s.gradeMax)}
                        {x.overridden ? ' *' : ''}
                      </td>
                      <td className="py-2">
                        {pct(
                          o.reviewers.find((g) => g.id === x.author.id)?.grade ?? null,
                          s.gradingGradeMax,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title={t('noSubmissions')} />
          )}
        </section>
      ) : null}
    </div>
  );
}

async function EditPage({ activity: a, course, ctx }: Props) {
  const t = await getTranslations('mod.workshop');
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;
  const o = await workshopOverview(ctx, a);
  if (!o.rights.submit) return <Alert variant="destructive">{t('cannotSubmit')}</Alert>;
  const files = o.mine ? await ctx.files.list(a.id, 'submission', o.mine.id) : [];
  return (
    <div className="grid max-w-3xl gap-4">
      <Back href={base} label={t('back')} />
      <h2 className="text-lg font-semibold">{o.mine ? t('editWork') : t('submitWork')}</h2>
      {s.instructAuthors ? <RichText html={s.instructAuthors} /> : null}
      <SubmissionForm
        activityId={a.id}
        courseId={course.id}
        base={base}
        submission={o.mine && { title: o.mine.title, content: o.mine.content }}
        files={files.map((f) => ({ id: f.id, name: f.name, url: f.url }))}
        text={s.submissionText}
        attach={s.submissionFiles}
        maxAttachments={s.maxAttachments}
      />
    </div>
  );
}

/** A filled form, read only: each dimension's answer and comment. */
async function FilledForm({
  activity: a,
  ctx,
  filling,
}: Pick<Props, 'activity' | 'ctx'> & { filling: Filling }) {
  const t = await getTranslations('mod.workshop');
  const form = await formOf(ctx.db, a);
  return (
    <dl className="grid gap-2 text-sm">
      {form.dimensions.map((d, i) => {
        const v = filling[d.id] ?? {};
        const answer =
          form.strategy === 'accumulative'
            ? `${v.grade ?? '—'} / ${d.maxGrade}`
            : form.strategy === 'numerrors'
              ? v.passed === undefined
                ? '—'
                : v.passed
                  ? d.positive || t('yes')
                  : d.negative || t('no')
              : form.strategy === 'rubric'
                ? (d.levels?.find((l) => l.id === v.levelId)?.definition ?? '—')
                : '';
        return (
          <div key={d.id} className="grid gap-0.5">
            <dt className="text-muted-foreground">
              {i + 1}. <RichText html={d.description} className="inline" />
            </dt>
            <dd>
              {answer}
              {v.comment ? <span className="block whitespace-pre-line">{v.comment}</span> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

async function SubmissionPage({ activity: a, course, ctx, id }: Props & { id: string }) {
  const [t, format] = await Promise.all([getTranslations('mod.workshop'), getFormatter()]);
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;
  const v = await submissionView(ctx, a, id);
  if (!v) return <Alert>{t('notFound')}</Alert>;
  const sub = v.submission;
  const files = await ctx.files.list(a.id, 'submission', sub.id);
  return (
    <div className="grid max-w-3xl gap-4">
      <Back href={base} label={t('back')} />
      <article aria-labelledby="ws-title" className="grid gap-3">
        <h2 id="ws-title" className="text-xl font-semibold">
          {sub.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {v.authorName ?? t('anonymousAuthor')} ·{' '}
          {format.dateTime(sub.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          {sub.late ? ` · ${t('late')}` : ''}
        </p>
        {sub.content ? <RichText html={sub.content} /> : null}
        {files.length ? (
          <ul className="grid gap-1 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a href={f.url} className="text-accent hover:underline">
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
      {(v.own || v.rights.viewAll) &&
      (sub.gradeOver ?? sub.grade) !== null &&
      (v.phase === 'closed' || v.rights.viewAll) ? (
        <p className="text-sm">
          {t('yourGrade', { grade: pct(sub.gradeOver ?? sub.grade, s.gradeMax), max: s.gradeMax })}
        </p>
      ) : null}
      {sub.feedback && (v.own || v.rights.viewAll) ? (
        <Card>
          <CardContent className="grid gap-2 pt-5">
            <h3 className="font-medium">{t('teacherFeedback')}</h3>
            <RichText html={sub.feedback} />
          </CardContent>
        </Card>
      ) : null}
      {v.assessments.length ? (
        <section aria-labelledby="ws-assessments" className="grid gap-3">
          <h3 id="ws-assessments" className="text-lg font-semibold">
            {t('assessments')}
          </h3>
          {v.assessments.map((x) => (
            <Card key={x.id}>
              <CardContent className="grid gap-3 pt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{x.reviewerName ?? t('anonymousReviewer')}</span>
                  <span className="text-sm text-muted-foreground">
                    {x.assessedAt
                      ? t('assessmentGrade', {
                          grade: x.grade === null ? '—' : Math.round(x.grade),
                        })
                      : t('waitingBadge')}
                  </span>
                </div>
                {x.assessedAt ? (
                  <>
                    <FilledForm activity={a} ctx={ctx} filling={(x.filling ?? {}) as Filling} />
                    {x.feedbackAuthor ? <RichText html={x.feedbackAuthor} /> : null}
                  </>
                ) : null}
                {x.reviewerId === (ctx.actor.kind === 'user' ? ctx.actor.userId : '') ? (
                  <Link
                    href={`${base}?assess=${x.id}`}
                    className="text-sm text-accent hover:underline"
                  >
                    {t('openAssessment')}
                  </Link>
                ) : null}
                {v.rights.manage ? (
                  <GradeAssessment
                    activityId={a.id}
                    assessmentId={x.id}
                    weight={x.weight}
                    gradingGradeOver={x.gradingGradeOver}
                    gradingGradeMax={s.gradingGradeMax}
                    feedbackReviewer={x.feedbackReviewer}
                  />
                ) : x.feedbackReviewer &&
                  x.reviewerId === (ctx.actor.kind === 'user' ? ctx.actor.userId : '') ? (
                  <p className="text-sm">{t('teacherComment', { text: x.feedbackReviewer })}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </section>
      ) : null}
      {v.rights.manage ? (
        <>
          {v.phase !== 'setup' &&
          !v.assessments.some(
            (x) => x.reviewerId === (ctx.actor.kind === 'user' ? ctx.actor.userId : ''),
          ) ? (
            <Button asChild variant="outline" className="justify-self-start">
              <Link href={`${base}?assess=new&for=${sub.id}`}>{t('assessYourself')}</Link>
            </Button>
          ) : null}
          <GradeSubmission
            activityId={a.id}
            submissionId={sub.id}
            gradeMax={s.gradeMax}
            gradeOver={sub.gradeOver}
            feedback={sub.feedback}
            published={sub.published}
          />
        </>
      ) : null}
    </div>
  );
}

async function AssessPage({
  activity: a,
  course,
  ctx,
  id,
  searchParams: sp,
}: Props & { id: string }) {
  const t = await getTranslations('mod.workshop');
  const s = a.settings;
  const base = `/course/${course.id}/a/${a.id}`;
  const user = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
  const manage = await ctx.perm.can('mod.workshop:manage', a.id);
  const x =
    id === 'new'
      ? null
      : await ctx.db.workshopAssessment.findFirst({
          where: { id, reviewerId: user, submission: { activityId: a.id } },
        });
  const submissionId = x?.submissionId ?? (manage && id === 'new' ? sp.for : undefined);
  const v = submissionId ? await submissionView(ctx, a, submissionId) : null;
  if (!v) return <Alert>{t('notFound')}</Alert>;
  const { phase } = await workshopState(ctx.db, a.id);
  const form = await formOf(ctx.db, a);
  const open =
    manage ||
    (phase === 'assessment' &&
      (!s.assessmentStart || ctx.now >= new Date(s.assessmentStart)) &&
      (!s.assessmentEnd || ctx.now <= new Date(s.assessmentEnd)));
  const files = await ctx.files.list(a.id, 'submission', v.submission.id);
  return (
    <div className="grid max-w-3xl gap-4">
      <Back href={base} label={t('back')} />
      <article
        aria-labelledby="wa-title"
        className="grid gap-3 rounded-lg border border-border p-4"
      >
        <h2 id="wa-title" className="text-lg font-semibold">
          {v.submission.title}
        </h2>
        {v.authorName ? <p className="text-sm text-muted-foreground">{v.authorName}</p> : null}
        {v.submission.content ? <RichText html={v.submission.content} /> : null}
        {files.length ? (
          <ul className="grid gap-1 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a href={f.url} className="text-accent hover:underline">
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
      {s.instructReviewers && open ? <RichText html={s.instructReviewers} /> : null}
      <h3 className="text-lg font-semibold">{t('yourAssessment')}</h3>
      {!open ? <Alert>{t('assessmentClosed')}</Alert> : null}
      <AssessmentForm
        activityId={a.id}
        base={base}
        strategy={form.strategy}
        dimensions={form.dimensions}
        assessmentId={x?.id ?? null}
        submissionId={v.submission.id}
        filling={(x?.filling ?? {}) as Filling}
        feedback={x?.feedbackAuthor ?? ''}
        readOnly={!open}
      />
    </div>
  );
}

async function FormTab({ activity: a, ctx }: Props) {
  const t = await getTranslations('mod.workshop');
  const form = await formOf(ctx.db, a);
  const used = await ctx.db.workshopAssessment.count({
    where: { submission: { activityId: a.id }, assessedAt: { not: null } },
  });
  return (
    <div className="grid max-w-3xl gap-4">
      <h2 className="text-lg font-semibold">
        {t('form.title', { strategy: t(`strategies.${form.strategy}`) })}
      </h2>
      {used ? <Alert>{t('form.locked')}</Alert> : null}
      <FormEditor
        activityId={a.id}
        strategy={form.strategy}
        dimensions={form.dimensions}
        mapping={form.mapping ?? {}}
        locked={used > 0}
      />
    </div>
  );
}

async function AllocationTab({ activity: a, ctx }: Props) {
  const t = await getTranslations('mod.workshop');
  const [subs, reviewerIds] = await Promise.all([
    ctx.db.workshopSubmission.findMany({
      where: { activityId: a.id },
      include: {
        author: { select: { name: true } },
        assessments: { include: { reviewer: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    }),
    ctx.perm.usersWithCap('mod.workshop:peerassess', a.id),
  ]);
  const reviewers = await ctx.db.user.findMany({
    where: { id: { in: reviewerIds } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return (
    <div className="grid max-w-4xl gap-4">
      <RandomAllocation activityId={a.id} groups={a.groupMode !== 'NONE'} />
      {subs.length ? (
        <ul className="grid gap-2">
          {subs.map((sub) => (
            <li key={sub.id} className="grid gap-2 rounded-lg border border-border p-3">
              <span>
                <span className="font-medium">{sub.title}</span>{' '}
                <span className="text-sm text-muted-foreground">{sub.author.name}</span>
              </span>
              <AllocationRow
                activityId={a.id}
                submissionId={sub.id}
                reviewers={sub.assessments.map((x) => ({
                  assessmentId: x.id,
                  name: x.reviewer.name,
                  assessed: !!x.assessedAt,
                }))}
                candidates={reviewers.filter(
                  (r) =>
                    !sub.assessments.some((x) => x.reviewerId === r.id) &&
                    (r.id !== sub.authorId || a.settings.selfAssessment),
                )}
              />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('noSubmissions')} />
      )}
    </div>
  );
}
