import { RichText } from '@hubium/editor/client';
import type { ViewProps } from '@hubium/module-sdk/ui';
import { Alert, Badge, Card, CardContent, Table, TBody, Td, THead, Th, Tr } from '@hubium/ui';
import { ArrowLeft, FileIcon, Lock, Pin } from 'lucide-react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  type ForumSettingsT,
  isModerator,
  postVisible,
  qandaLocked,
  subscriptionState,
  userGroupIds,
  visibleGroupFilter,
} from '../server.ts';
import {
  MarkRead,
  ModerateButtons,
  NewDiscussionForm,
  PostActions,
  SubscribeButton,
} from './client.tsx';

type Props = ViewProps<ForumSettingsT>;

const PAGE = 30;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

export async function ForumView(props: Props) {
  if (props.ctx.actor.kind !== 'user') return null;
  return props.searchParams.d ? (
    <DiscussionView {...props} discussionId={props.searchParams.d} />
  ) : (
    <ForumIndex {...props} />
  );
}

async function ForumIndex({ activity: a, ctx, searchParams }: Props) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
  const [t, format] = await Promise.all([getTranslations('mod.forum'), getFormatter()]);
  const moderator = await isModerator(ctx, a);
  const canStart =
    (await ctx.perm.can('mod.forum:startdiscussion', a.id)) &&
    (a.settings.type === 'general' || moderator);
  const groupFilter = await visibleGroupFilter(ctx, a, me);
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const where = {
    activityId: a.id,
    ...(groupFilter ? { OR: [{ groupId: null }, { groupId: { in: groupFilter } }] } : {}),
  };
  const [discussions, total, sub] = await Promise.all([
    ctx.db.forumDiscussion.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { lastPostAt: 'desc' }],
      skip: (page - 1) * PAGE,
      take: PAGE,
      include: {
        author: { select: { name: true } },
        group: { select: { name: true } },
        readStates: { where: { userId: me } },
      },
    }),
    ctx.db.forumDiscussion.count({ where }),
    subscriptionState(ctx, a, me),
  ]);
  const unread = await Promise.all(
    discussions.map((d) =>
      ctx.db.forumPost.count({
        where: {
          discussionId: d.id,
          deletedAt: null,
          authorId: { not: me },
          ...(d.readStates[0] ? { createdAt: { gt: d.readStates[0].lastReadAt } } : {}),
          ...(moderator ? {} : { OR: [{ privateToUserId: null }, { privateToUserId: me }] }),
        },
      }),
    ),
  );
  // Members choose a group for new discussions; moderators may also post to everyone.
  const groups =
    a.groupMode === 'NONE'
      ? []
      : moderator
        ? await ctx.db.group.findMany({
            where: { courseId: a.courseId },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          })
        : await ctx.db.group.findMany({
            where: { id: { in: await userGroupIds(ctx.db, a.courseId, me) } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          });
  const base = `/course/${a.courseId}/a/${a.id}`;
  return (
    <div className="grid gap-4">
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
          <SubscribeButton activityId={a.id} subscribed={sub.forum} />
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
            {discussions.map((d, i) => (
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
                    {unread[i] ? (
                      <Badge variant="accent">{t('unread', { n: unread[i]! })}</Badge>
                    ) : null}
                    {d.group ? <Badge>{d.group.name}</Badge> : null}
                  </div>
                </Td>
                <Td className="hidden text-sm sm:table-cell">{d.author?.name ?? '—'}</Td>
                <Td className="text-right tabular-nums">{Math.max(0, d.postCount - 1)}</Td>
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

interface PostNode {
  id: string;
  parentId: string | null;
  authorId: string | null;
  authorName: string;
  contentHtml: string;
  privateToUserId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  children: PostNode[];
}

async function DiscussionView({
  activity: a,
  ctx,
  discussionId,
}: Props & { discussionId: string }) {
  const me = ctx.actor.kind === 'user' ? ctx.actor.userId : '';
  const [t, format] = await Promise.all([getTranslations('mod.forum'), getFormatter()]);
  const base = `/course/${a.courseId}/a/${a.id}`;
  const d = await ctx.db.forumDiscussion.findUnique({
    where: { id: discussionId },
    include: { group: { select: { name: true } } },
  });
  const groupFilter = await visibleGroupFilter(ctx, a, me);
  if (
    !d ||
    d.activityId !== a.id ||
    (groupFilter && d.groupId && !groupFilter.includes(d.groupId))
  ) {
    return <Alert variant="warning">{t('notFound')}</Alert>;
  }
  const moderator = await isModerator(ctx, a);
  const [canPost, locked, sub] = await Promise.all([
    ctx.perm.can('mod.forum:post', a.id),
    qandaLocked(ctx, a, d.id, me),
    subscriptionState(ctx, a, me, d.id),
  ]);
  const myGroups = d.groupId && !moderator ? await userGroupIds(ctx.db, a.courseId, me) : [];
  const inGroup = !d.groupId || moderator || myGroups.includes(d.groupId);
  const rows = await ctx.db.forumPost.findMany({
    where: { discussionId: d.id },
    orderBy: { createdAt: 'asc' },
    include: { author: { select: { name: true } } },
  });
  const files = await ctx.files.list(a.id, 'attachment');
  const visible = rows.filter(
    (p) =>
      postVisible(p, me, moderator) &&
      // Q&A: until the user replies, only the question and their own posts are shown
      (!locked || p.parentId === null || p.authorId === me),
  );
  const nodes = new Map<string, PostNode>(
    visible.map((p) => [
      p.id,
      {
        id: p.id,
        parentId: p.parentId,
        authorId: p.authorId,
        authorName: p.author?.name ?? t('deletedUser'),
        contentHtml: p.deletedAt ? '' : p.contentHtml,
        privateToUserId: p.privateToUserId,
        createdAt: p.createdAt,
        editedAt: p.editedAt,
        deleted: !!p.deletedAt,
        children: [],
      },
    ]),
  );
  const roots: PostNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else if (!n.parentId) roots.push(n);
  }
  const now = Date.now();
  const editable = (p: PostNode) =>
    !p.deleted &&
    (moderator ||
      (p.authorId === me && now - p.createdAt.getTime() <= a.settings.editMinutes * 60_000));

  const renderPost = (p: PostNode, depth: number) => {
    const attachments = files.filter((f) => f.itemId === p.id);
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
              {initials(p.authorName)}
            </span>
            <span id={`pa-${p.id}`} className="font-medium">
              {p.authorName}
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
              canReply={canPost && inGroup && (!d.locked || moderator)}
              canPrivate={moderator && a.settings.allowPrivateReplies && p.authorId !== me}
              canEdit={editable(p)}
              canDelete={editable(p) && (moderator || p.children.length === 0)}
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
        {d.group ? <Badge>{d.group.name}</Badge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {a.settings.subscription === 'optional' || a.settings.subscription === 'auto' ? (
          <SubscribeButton activityId={a.id} discussionId={d.id} subscribed={sub.discussion} />
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
      <ul className="grid gap-3">{roots.map((r) => renderPost(r, 0))}</ul>
      {!roots.length ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">{t('empty')}</CardContent>
        </Card>
      ) : null}
      <MarkRead activityId={a.id} discussionId={d.id} />
    </div>
  );
}
