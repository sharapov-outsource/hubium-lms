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
import { ArrowLeft, FileIcon, Lock, Pin } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  DISCUSSIONS_PAGE,
  type ForumPostView,
  type ForumSettingsT,
  readDiscussion,
  readDiscussions,
  readUserPosts,
  scaleItems,
} from '../server.ts';
import {
  ForumGradeForm,
  MarkRead,
  ModerateButtons,
  NewDiscussionForm,
  PostActions,
  PostRatingControl,
  SubscribeButton,
} from './client.tsx';

type Props = ViewProps<ForumSettingsT>;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

export async function ForumView(props: Props) {
  if (props.ctx.actor.kind !== 'user') return null;
  const { activity: a, ctx, searchParams } = props;
  if (
    searchParams.tab === 'grading' &&
    a.settings.wholeForumGrading &&
    (await ctx.perm.can('mod.forum:grade', a.id))
  )
    return <GradingView {...props} />;
  return searchParams.d ? (
    <DiscussionView {...props} discussionId={searchParams.d} />
  ) : (
    <ForumIndex {...props} />
  );
}

/** A grade as people read it: the scale's grade, or points out of the maximum. */
const gradeText = (
  grade: number | null,
  scale: string[] | null,
  max: number,
  outOf: (max: number) => string,
) =>
  grade === null ? '—' : scale ? (scale[Math.round(grade) - 1] ?? '—') : `${grade} ${outOf(max)}`;

async function ForumIndex({ activity: a, ctx, searchParams }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.forum'), getFormatter()]);
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const {
    items: discussions,
    total,
    canStart,
    moderator,
    subscribed,
    groups,
    myGrade,
    canGrade,
  } = await readDiscussions(ctx, a, { page });
  const PAGE = DISCUSSIONS_PAGE;
  const base = `/course/${a.courseId}/a/${a.id}`;
  return (
    <div className="grid gap-4">
      {myGrade ? (
        <Card className="border-success/40">
          <CardHeader>
            <CardTitle>
              {t('grading.yourGrade')}:{' '}
              {gradeText(myGrade.grade, myGrade.scale, myGrade.gradeMax, (max) =>
                t('grading.outOf', { max }),
              )}
            </CardTitle>
          </CardHeader>
          {myGrade.feedback ? (
            <CardContent>
              <RichText html={myGrade.feedback} />
            </CardContent>
          ) : null}
        </Card>
      ) : null}
      {canGrade ? (
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link href={`${base}?tab=grading`}>{t('grading.open')}</Link>
        </Button>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        {canStart ? (
          <NewDiscussionForm
            activityId={a.id}
            courseId={a.courseId}
            groups={groups}
            canPin={moderator}
            maxAttachments={a.settings.maxAttachments}
          />
        ) : (
          <span />
        )}
        {a.settings.subscription === 'optional' || a.settings.subscription === 'auto' ? (
          <SubscribeButton activityId={a.id} subscribed={subscribed} />
        ) : null}
      </div>
      {a.settings.type === 'qanda' ? <Alert>{t('qandaHint')}</Alert> : null}
      {discussions.length ? (
        <Table>
          <THead>
            <Tr>
              <Th>{t('discussion')}</Th>
              <Th className="hidden sm:table-cell">{t('startedBy')}</Th>
              <Th className="text-right">{t('replies')}</Th>
              <Th className="hidden md:table-cell">{t('lastPost')}</Th>
            </Tr>
          </THead>
          <TBody>
            {discussions.map((d) => (
              <Tr key={d.id}>
                <Td>
                  <div className="flex flex-wrap items-center gap-2">
                    {d.pinned ? (
                      <Pin className="size-4 text-accent" aria-label={t('pinned')} />
                    ) : null}
                    {d.locked ? (
                      <Lock className="size-4 text-muted-foreground" aria-label={t('locked')} />
                    ) : null}
                    <Link href={`${base}?d=${d.id}`} className="font-medium hover:underline">
                      {d.title}
                    </Link>
                    {d.unread ? (
                      <Badge variant="accent">{t('unread', { n: d.unread })}</Badge>
                    ) : null}
                    {d.groupName ? <Badge>{d.groupName}</Badge> : null}
                    {d.groupDeleted ? <Badge variant="warning">{t('groupDeleted')}</Badge> : null}
                  </div>
                </Td>
                <Td className="hidden text-sm sm:table-cell">{d.authorName ?? '—'}</Td>
                <Td className="text-right tabular-nums">{d.replies}</Td>
                <Td className="hidden text-sm text-muted-foreground md:table-cell">
                  {format.relativeTime(d.lastPostAt)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      )}
      {total > PAGE ? (
        <nav aria-label={t('pages')} className="flex gap-2 text-sm">
          {page > 1 ? <Link href={`${base}?page=${page - 1}`}>← {t('newer')}</Link> : null}
          {page * PAGE < total ? (
            <Link href={`${base}?page=${page + 1}`}>{t('older')} →</Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

type PostNode = ForumPostView & { children: PostNode[] };

async function DiscussionView({
  activity: a,
  ctx,
  discussionId,
}: Props & { discussionId: string }) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
  const [t, format] = await Promise.all([getTranslations('mod.forum'), getFormatter()]);
  const base = `/course/${a.courseId}/a/${a.id}`;
  const r = await readDiscussion(ctx, a, discussionId);
  if (!r) return <Alert variant="warning">{t('notFound')}</Alert>;
  const { discussion: d, moderator, canReply, canReplyPrivately } = r;
  const locked = r.qandaLocked;
  const nodes = new Map<string, PostNode>(r.posts.map((p) => [p.id, { ...p, children: [] }]));
  const roots: PostNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else if (!n.parentId) roots.push(n);
  }

  const renderPost = (p: PostNode, depth: number) => {
    const attachments = p.attachments;
    const authorName = p.authorName ?? t('deletedUser');
    return (
      <li key={p.id} className="grid gap-3">
        <article
          id={`p-${p.id}`}
          aria-labelledby={`pa-${p.id}`}
          className="grid gap-3 rounded-lg border border-border bg-card p-4"
        >
          <header className="flex flex-wrap items-center gap-2 text-sm">
            <span
              aria-hidden
              className="grid size-8 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
            >
              {initials(authorName)}
            </span>
            <span id={`pa-${p.id}`} className="font-medium">
              {authorName}
            </span>
            <time dateTime={p.createdAt.toISOString()} className="text-muted-foreground">
              {format.dateTime(p.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
            </time>
            {p.editedAt ? <span className="text-muted-foreground">({t('edited')})</span> : null}
            {p.privateToUserId ? <Badge variant="warning">{t('private')}</Badge> : null}
          </header>
          {p.deleted ? (
            <p className="text-sm italic text-muted-foreground">{t('postDeleted')}</p>
          ) : (
            <RichText html={p.contentHtml} />
          )}
          {p.rating && r.rating && r.rating.aggregate !== 'none' ? (
            <PostRatingControl
              activityId={a.id}
              postId={p.id}
              authorName={authorName}
              kind={r.rating.aggregate}
              scale={r.rating.scale}
              max={r.rating.max}
              rating={p.rating}
            />
          ) : null}
          {attachments.length ? (
            <ul className="flex flex-wrap gap-2 text-sm">
              {attachments.map((f) => (
                <li key={f.id}>
                  <a
                    href={f.url}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted"
                  >
                    <FileIcon className="size-4" aria-hidden />
                    {f.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {!p.deleted ? (
            <PostActions
              activityId={a.id}
              postId={p.id}
              html={p.contentHtml}
              canReply={canReply}
              canPrivate={canReplyPrivately && p.authorId !== me}
              canEdit={p.editable}
              canDelete={p.deletable}
              isRoot={p.parentId === null}
              maxAttachments={a.settings.maxAttachments}
              backUrl={base}
            />
          ) : null}
        </article>
        {p.children.length ? (
          <ul
            className={
              depth < 3 ? 'grid gap-3 border-l-2 border-border pl-4 sm:pl-6' : 'grid gap-3'
            }
          >
            {p.children.map((c) => renderPost(c, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="grid gap-4">
      <Link
        href={base}
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('backToForum')}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{d.title}</h2>
        {d.pinned ? <Badge variant="accent">{t('pinned')}</Badge> : null}
        {d.locked ? <Badge variant="warning">{t('locked')}</Badge> : null}
        {d.groupName ? <Badge>{d.groupName}</Badge> : null}
        {d.groupDeleted ? <Badge variant="warning">{t('groupDeleted')}</Badge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {a.settings.subscription === 'optional' || a.settings.subscription === 'auto' ? (
          <SubscribeButton activityId={a.id} discussionId={d.id} subscribed={r.subscribed} />
        ) : null}
        {moderator ? (
          <ModerateButtons
            activityId={a.id}
            discussionId={d.id}
            pinned={d.pinned}
            locked={d.locked}
          />
        ) : null}
      </div>
      {d.locked ? <Alert variant="warning">{t('lockedHint')}</Alert> : null}
      {locked ? <Alert>{t('qandaLocked')}</Alert> : null}
      <ul className="grid gap-3">{roots.map((root) => renderPost(root, 0))}</ul>
      {!roots.length ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">{t('empty')}</CardContent>
        </Card>
      ) : null}
      <MarkRead activityId={a.id} discussionId={d.id} />
    </div>
  );
}

/**
 * Whole-forum grading: the students with their number of posts and grade, or one student's
 * posts beside the grade form.
 */
async function GradingView({ activity: a, ctx, searchParams }: Props) {
  const [t, format] = await Promise.all([getTranslations('mod.forum'), getFormatter()]);
  const base = `/course/${a.courseId}/a/${a.id}`;
  // students: those who post here without grading
  const [posters, graders, scale] = await Promise.all([
    ctx.perm.usersWithCap('mod.forum:post', a.id),
    ctx.perm.usersWithCap('mod.forum:grade', a.id),
    scaleItems(ctx.db, a, a.settings.gradeScaleId),
  ]);
  const gradersSet = new Set(graders);
  const users = await ctx.db.user.findMany({
    where: { id: { in: posters.filter((u) => !gradersSet.has(u)) }, deletedAt: null },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    select: { id: true, name: true },
  });
  const outOf = (max: number) => t('grading.outOf', { max });
  const userId = searchParams.user;
  const user = users.find((u) => u.id === userId);
  if (!user) {
    const [counts, grades] = await Promise.all([
      ctx.db.forumPost.groupBy({
        by: ['authorId'],
        where: {
          authorId: { in: users.map((u) => u.id) },
          deletedAt: null,
          discussion: { activityId: a.id },
        },
        _count: { _all: true },
      }),
      ctx.db.forumGrade.findMany({ where: { activityId: a.id } }),
    ]);
    return (
      <div className="grid gap-4">
        <Link
          href={base}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('backToForum')}
        </Link>
        <h2 className="text-xl font-semibold">{t('grading.title')}</h2>
        <Table>
          <THead>
            <Tr>
              <Th>{t('grading.student')}</Th>
              <Th className="text-right">{t('grading.posts')}</Th>
              <Th>{t('grading.grade')}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {users.map((u) => {
              const g = grades.find((x) => x.userId === u.id);
              return (
                <Tr key={u.id}>
                  <Td className="font-medium">{u.name}</Td>
                  <Td className="text-right tabular-nums">
                    {counts.find((c) => c.authorId === u.id)?._count._all ?? 0}
                  </Td>
                  <Td className="tabular-nums">
                    {gradeText(
                      g?.grade === null || g?.grade === undefined ? null : Number(g.grade),
                      scale,
                      a.settings.gradeMax,
                      outOf,
                    )}
                  </Td>
                  <Td className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`${base}?tab=grading&user=${u.id}`}
                        aria-label={`${t('grading.gradeAction')}: ${u.name}`}
                      >
                        {t('grading.gradeAction')}
                      </Link>
                    </Button>
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </div>
    );
  }
  const [posts, g] = await Promise.all([
    readUserPosts(ctx, a, user.id),
    ctx.db.forumGrade.findUnique({
      where: { activityId_userId: { activityId: a.id, userId: user.id } },
    }),
  ]);
  const next = users[users.indexOf(user) + 1];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`${base}?tab=grading`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('grading.back')}
        </Link>
        {next ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}?tab=grading&user=${next.id}`}>
              {t('grading.next')}: {next.name} →
            </Link>
          </Button>
        ) : null}
      </div>
      <h2 className="text-xl font-semibold">{t('grading.titleFor', { name: user.name })}</h2>
      <div className="grid gap-5 lg:grid-cols-[1fr_24rem]">
        <section aria-label={t('grading.posts')} className="grid content-start gap-3">
          {posts.length ? (
            posts.map((p) => (
              <article
                key={p.id}
                className="grid gap-2 rounded-lg border border-border bg-card p-4"
              >
                <header className="flex flex-wrap items-center gap-2 text-sm">
                  <Link
                    href={`${base}?d=${p.discussionId}#p-${p.id}`}
                    className="font-medium hover:underline"
                  >
                    {p.discussionTitle}
                  </Link>
                  <time dateTime={p.createdAt.toISOString()} className="text-muted-foreground">
                    {format.dateTime(p.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </time>
                  {p.parentId ? null : <Badge>{t('grading.started')}</Badge>}
                  {p.privateToUserId ? <Badge variant="warning">{t('private')}</Badge> : null}
                </header>
                <RichText html={p.contentHtml} />
              </article>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{t('grading.noPosts')}</p>
          )}
        </section>
        <ForumGradeForm
          activityId={a.id}
          userId={user.id}
          grade={g?.grade === null || g?.grade === undefined ? null : Number(g.grade)}
          feedback={g?.feedback ?? ''}
          gradeMax={a.settings.gradeMax}
          scale={scale}
          nextUrl={next ? `${base}?tab=grading&user=${next.id}` : null}
        />
      </div>
    </div>
  );
}
