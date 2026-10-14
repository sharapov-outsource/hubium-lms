'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import { callModuleAction } from '@hubium/module-sdk/form';
import { Button, Card, CardContent, Checkbox, Field, Input, Label, Select } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { Bell, BellOff, Lock, LockOpen, Pin, PinOff, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

function useAction(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(
    action: string,
    input: Record<string, unknown>,
    opts: { files?: File[]; ok?: string; done?: (data: T) => void; refresh?: boolean } = {},
  ) =>
    start(async () => {
      const r = await callModuleAction<T>(
        activityId,
        action,
        input,
        opts.files?.length ? { list: opts.files } : undefined,
      );
      if (!r.ok) {
        toast.error(r.message ?? 'Error');
        return;
      }
      if (opts.ok) toast.success(opts.ok);
      opts.done?.(r.data as T);
      if (opts.refresh !== false) router.refresh();
    });
  return { pending, run };
}

const filesOf = (form: HTMLFormElement) =>
  new FormData(form).getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

export function NewDiscussionForm({
  activityId,
  courseId,
  groups,
  canPin,
  maxAttachments,
}: {
  activityId: string;
  courseId: string;
  groups: { id: string; name: string }[];
  canPin: boolean;
  maxAttachments: number;
}) {
  const t = useTranslations('mod.forum');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  const ref = useRef<HTMLFormElement>(null);
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        <Plus className="size-4" aria-hidden />
        {t('newDiscussion')}
      </Button>
    );
  return (
    <Card>
      <CardContent className="pt-6">
        <form
          ref={ref}
          key={key}
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            run<{ discussionId: string }>(
              'startDiscussion',
              {
                title: String(fd.get('title') ?? ''),
                message: String(fd.get('message') ?? ''),
                groupId: fd.get('groupId') ? String(fd.get('groupId')) : null,
                pinned: fd.get('pinned') === 'on',
              },
              {
                files: filesOf(e.currentTarget),
                ok: t('posted'),
                refresh: false,
                done: (d) => {
                  setKey((k) => k + 1);
                  setOpen(false);
                  router.push(`/course/${courseId}/a/${activityId}?d=${d.discussionId}`);
                },
              },
            );
          }}
        >
          <Field label={t('subject')} htmlFor="fd-title">
            <Input id="fd-title" name="title" required maxLength={255} />
          </Field>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="fd-message">{t('message')}</Label>
            <RichTextEditor
              id="fd-message"
              name="message"
              labels={labels}
              ariaLabel={t('message')}
              minHeight={160}
            />
          </div>
          {groups.length ? (
            <Field label={t('group')} htmlFor="fd-group">
              <Select id="fd-group" name="groupId" defaultValue={groups[0]?.id}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {maxAttachments > 0 ? (
            <Field label={t('attachments', { max: maxAttachments })} htmlFor="fd-files">
              <Input id="fd-files" name="files" type="file" multiple />
            </Field>
          ) : null}
          {canPin ? (
            <label htmlFor="fd-pinned" className="flex items-center gap-2 text-sm">
              <Checkbox id="fd-pinned" name="pinned" />
              {t('pin')}
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {t('post')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PostActions({
  activityId,
  postId,
  html,
  canReply,
  canPrivate,
  canEdit,
  canDelete,
  isRoot,
  maxAttachments,
  backUrl,
}: {
  activityId: string;
  postId: string;
  html: string;
  canReply: boolean;
  canPrivate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isRoot: boolean;
  maxAttachments: number;
  backUrl: string;
}) {
  const t = useTranslations('mod.forum');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const [mode, setMode] = useState<'none' | 'reply' | 'edit' | 'delete'>('none');
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1">
        {canReply ? (
          <Button size="sm" variant="ghost" onClick={() => setMode('reply')}>
            {t('reply')}
          </Button>
        ) : null}
        {canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => setMode('edit')}>
            {t('edit')}
          </Button>
        ) : null}
        {canDelete ? (
          <Button size="sm" variant="ghost" onClick={() => setMode('delete')}>
            {t('delete')}
          </Button>
        ) : null}
      </div>
      {mode === 'delete' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-sm">
          <span>{isRoot ? t('deleteDiscussionConfirm') : t('deleteConfirm')}</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              run<{ discussionDeleted: boolean }>(
                'deletePost',
                { postId },
                {
                  ok: t('deleted'),
                  refresh: false,
                  done: (d) => {
                    setMode('none');
                    if (d.discussionDeleted) router.push(backUrl);
                    else router.refresh();
                  },
                },
              )
            }
          >
            {t('delete')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}
      {mode === 'reply' || mode === 'edit' ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const message = String(fd.get('message') ?? '');
            if (mode === 'edit') {
              run('editPost', { postId, message }, { ok: t('saved'), done: () => setMode('none') });
            } else {
              run(
                'reply',
                { postId, message, private: fd.get('private') === 'on' },
                {
                  files: filesOf(e.currentTarget),
                  ok: t('posted'),
                  done: () => setMode('none'),
                },
              );
            }
          }}
        >
          <Label htmlFor={`msg-${postId}`}>{mode === 'edit' ? t('edit') : t('yourReply')}</Label>
          <RichTextEditor
            id={`msg-${postId}`}
            name="message"
            defaultValue={mode === 'edit' ? html : ''}
            labels={labels}
            ariaLabel={mode === 'edit' ? t('edit') : t('yourReply')}
            minHeight={120}
          />
          {mode === 'reply' && maxAttachments > 0 ? (
            <Field label={t('attachments', { max: maxAttachments })} htmlFor={`files-${postId}`}>
              <Input id={`files-${postId}`} name="files" type="file" multiple />
            </Field>
          ) : null}
          {mode === 'reply' && canPrivate ? (
            <label htmlFor={`private-${postId}`} className="flex items-center gap-2 text-sm">
              <Checkbox id={`private-${postId}`} name="private" />
              {t('privateReply')}
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {mode === 'edit' ? t('save') : t('post')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode('none')}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function SubscribeButton({
  activityId,
  discussionId,
  subscribed,
}: {
  activityId: string;
  discussionId?: string;
  subscribed: boolean;
}) {
  const t = useTranslations('mod.forum');
  const { pending, run } = useAction(activityId);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      aria-pressed={subscribed}
      onClick={() =>
        run(
          'subscribe',
          { discussionId: discussionId ?? null, subscribed: !subscribed },
          { ok: subscribed ? t('unsubscribed') : t('subscribed') },
        )
      }
    >
      {subscribed ? (
        <BellOff className="size-4" aria-hidden />
      ) : (
        <Bell className="size-4" aria-hidden />
      )}
      {subscribed
        ? discussionId
          ? t('unfollowDiscussion')
          : t('unsubscribeForum')
        : discussionId
          ? t('followDiscussion')
          : t('subscribeForum')}
    </Button>
  );
}

export function ModerateButtons({
  activityId,
  discussionId,
  pinned,
  locked,
}: {
  activityId: string;
  discussionId: string;
  pinned: boolean;
  locked: boolean;
}) {
  const t = useTranslations('mod.forum');
  const { pending, run } = useAction(activityId);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run('moderate', { discussionId, pinned: !pinned })}
      >
        {pinned ? (
          <PinOff className="size-4" aria-hidden />
        ) : (
          <Pin className="size-4" aria-hidden />
        )}
        {pinned ? t('unpin') : t('pin')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => run('moderate', { discussionId, locked: !locked })}
      >
        {locked ? (
          <LockOpen className="size-4" aria-hidden />
        ) : (
          <Lock className="size-4" aria-hidden />
        )}
        {locked ? t('unlock') : t('lock')}
      </Button>
    </>
  );
}

/** Marks the discussion read once it has been displayed. */
export function MarkRead({
  activityId,
  discussionId,
}: {
  activityId: string;
  discussionId: string;
}) {
  useEffect(() => {
    void callModuleAction(activityId, 'markRead', { discussionId });
  }, [activityId, discussionId]);
  return null;
}

/**
 * A post's rating: the aggregate as the user may see it, who rated what, and a select for
 * those who rate (points 0..max, or the forum's scale).
 */
export function PostRatingControl({
  activityId,
  postId,
  authorName,
  kind,
  scale,
  max,
  rating,
}: {
  activityId: string;
  postId: string;
  authorName: string;
  kind: 'average' | 'count' | 'max' | 'min' | 'sum';
  scale: string[] | null;
  max: number;
  rating: {
    aggregate: number | null;
    count: number;
    mine: number | null;
    canRate: boolean;
    raters: { name: string; value: number }[];
  };
}) {
  const t = useTranslations('mod.forum.rating');
  const { pending, run } = useAction(activityId);
  const label = (v: number) => (scale ? (scale[v - 1] ?? String(v)) : String(v));
  // a count is a number of ratings, not a rating
  const shown = (v: number) => (scale && kind !== 'count' ? label(Math.round(v)) : String(v));
  const values = scale ? scale.map((_, i) => i + 1) : Array.from({ length: max + 1 }, (_, i) => i);
  if (rating.aggregate === null && !rating.canRate) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {rating.aggregate !== null ? (
        <span>
          {t(`aggregates.${kind}`, { value: shown(rating.aggregate) })}{' '}
          <span className="text-muted-foreground">({t('count', { n: rating.count })})</span>
        </span>
      ) : null}
      {rating.canRate ? (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="text-muted-foreground">
            {t('yours')}
          </span>
          <Select
            id={`rate-${postId}`}
            aria-label={t('rateLabel', { name: authorName })}
            className="w-40"
            value={rating.mine === null ? '' : String(rating.mine)}
            disabled={pending}
            onChange={(e) =>
              run(
                'rate',
                { postId, value: e.target.value === '' ? null : Number(e.target.value) },
                { ok: t('saved') },
              )
            }
          >
            <option value="">—</option>
            {values.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </Select>
        </span>
      ) : null}
      {rating.raters.length ? (
        <details className="w-full">
          <summary className="cursor-pointer text-muted-foreground">{t('raters')}</summary>
          <ul className="mt-1 grid gap-0.5 pl-4">
            {rating.raters.map((r) => (
              <li key={r.name}>
                {r.name}: {label(r.value)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The grade and feedback for a student's part in the whole forum. */
export function ForumGradeForm({
  activityId,
  userId,
  grade,
  feedback,
  gradeMax,
  scale,
  nextUrl,
}: {
  activityId: string;
  userId: string;
  grade: number | null;
  feedback: string;
  gradeMax: number;
  scale: string[] | null;
  nextUrl: string | null;
}) {
  const t = useTranslations('mod.forum.grading');
  const labels = useEditorLabels();
  const router = useRouter();
  const { pending, run } = useAction(activityId);
  const ref = useRef<HTMLFormElement>(null);
  const [scaleGrade, setScaleGrade] = useState(grade === null ? '' : String(grade));
  const save = (goNext: boolean) => {
    const fd = new FormData(ref.current!);
    const raw = String(fd.get('grade') ?? '')
      .replace(',', '.')
      .trim();
    run(
      'gradeUser',
      {
        userId,
        grade: raw === '' ? null : Number(raw),
        feedback: String(fd.get('feedback') ?? ''),
      },
      {
        ok: t('saved'),
        done: () => {
          if (goNext && nextUrl) router.push(nextUrl);
        },
      },
    );
  };
  return (
    <Card>
      <CardContent className="pt-5">
        <form ref={ref} className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          {scale ? (
            <Field label={t('grade')} htmlFor="forum-grade">
              <Select
                id="forum-grade"
                name="grade"
                value={scaleGrade}
                onChange={(e) => setScaleGrade(e.target.value)}
                className="w-56"
              >
                <option value="">—</option>
                {scale.map((s, i) => (
                  <option key={s} value={i + 1}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={`${t('grade')} (${t('outOf', { max: gradeMax })})`} htmlFor="forum-grade">
              <Input
                id="forum-grade"
                name="grade"
                inputMode="decimal"
                defaultValue={grade ?? ''}
                className="w-32"
              />
            </Field>
          )}
          <div className="grid content-start gap-1.5">
            <Label htmlFor="forum-feedback">{t('feedback')}</Label>
            <RichTextEditor
              id="forum-feedback"
              name="feedback"
              defaultValue={feedback}
              labels={labels}
              ariaLabel={t('feedback')}
              minHeight={120}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending} onClick={() => save(false)}>
              {t('save')}
            </Button>
            {nextUrl ? (
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => save(true)}
              >
                {t('save')} → {t('next')}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
