'use client';

import { EditorField } from '@hubium/editor/field';
import { callModuleAction, useFailureText } from '@hubium/module-sdk/form';
import { Alert, Button } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

type Lock = { locked: boolean; by: string | null; until: string | null };

/**
 * Changes a page, or writes a new one. An existing page is locked for others while the
 * editor is open (renewed every 30 s); another's lock shows who holds it, and teachers
 * may take it over.
 */
export function WikiEditor({
  activityId,
  courseId,
  pageId,
  title,
  content,
  baseVersion,
  subwiki,
  back,
  canOverride,
}: {
  activityId: string;
  courseId: string;
  pageId: string | null;
  title: string;
  content: string;
  baseVersion: number;
  subwiki: { groupId: string | null; userId: string | null };
  /** The page's URL without the editor. */
  back: string;
  canOverride: boolean;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.wiki');
  const tc = useTranslations('common');
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [lock, setLock] = useState<Lock | null>(
    pageId ? null : { locked: true, by: null, until: null },
  );
  const saved = useRef(false);
  // once editing, the editor stays: losing the lock (taken over, or run out) must not
  // take away what was typed
  const editing = useRef(!pageId);

  const take = async (force = false) => {
    if (!pageId) return;
    const r = await callModuleAction<Lock>(activityId, 'lock', { pageId, force });
    if (!r.ok) return void toast.error(failed(r));
    setLock(r.data ?? null);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: lock once, renew while open
  useEffect(() => {
    if (!pageId) return;
    void take();
    const id = setInterval(() => {
      if (!saved.current) void take();
    }, 30_000);
    return () => {
      clearInterval(id);
      if (!saved.current) void callModuleAction(activityId, 'unlock', { pageId });
    };
  }, [pageId]);

  if (!lock) return <p className="text-sm text-muted-foreground">{t('locking')}</p>;
  if (lock.locked) editing.current = true;
  const lost = !lock.locked && editing.current;
  if (!lock.locked && !lost)
    return (
      <div className="grid gap-3">
        <Alert variant="warning">
          {t('lockedBy', {
            name: lock.by ?? '—',
            time: lock.until ? format.dateTime(new Date(lock.until), { timeStyle: 'short' }) : '—',
          })}
        </Alert>
        <div className="flex flex-wrap gap-2">
          {canOverride ? <Button onClick={() => void take(true)}>{t('override')}</Button> : null}
          <Button asChild variant="outline">
            <Link href={back}>{tc('cancel')}</Link>
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        if (lost) return void e.preventDefault();
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        start(async () => {
          const r = await callModuleAction<{ pageId: string }>(activityId, 'save', {
            ...subwiki,
            ...(pageId ? { pageId, baseVersion } : { title }),
            content: String(fd.get('content') ?? ''),
          });
          if (!r.ok || !r.data) return void toast.error(failed(r));
          saved.current = true;
          toast.success(t('saved'));
          const url = new URL(back, window.location.origin);
          url.searchParams.delete('title');
          url.searchParams.set('page', r.data.pageId);
          router.push(`${url.pathname}${url.search}`);
          router.refresh();
        });
      }}
    >
      {lost ? (
        <Alert variant="warning">
          {t('lockLost', { name: lock.by ?? '—' })}
          {canOverride ? (
            <Button type="button" size="sm" className="ml-2" onClick={() => void take(true)}>
              {t('override')}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      <EditorField
        name="content"
        label={t('content')}
        defaultValue={content}
        courseId={courseId}
        minHeight={320}
      />
      <p className="text-xs text-muted-foreground">{t('linkHint')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || lost}>
          {tc('save')}
        </Button>
        <Button asChild variant="outline">
          <Link href={back}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

export function RestoreVersion({
  activityId,
  pageId,
  version,
  back,
}: {
  activityId: string;
  pageId: string;
  version: number;
  back: string;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.wiki');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(t('restoreConfirm', { version }))) return;
        start(async () => {
          const r = await callModuleAction(activityId, 'restore', { pageId, version });
          if (!r.ok) return void toast.error(failed(r));
          toast.success(t('restored'));
          router.push(back);
          router.refresh();
        });
      }}
    >
      {t('restore')}
    </Button>
  );
}

export function DeletePage({
  activityId,
  pageId,
  title,
  back,
}: {
  activityId: string;
  pageId: string;
  title: string;
  back: string;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.wiki');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(t('deleteConfirm', { title }))) return;
        start(async () => {
          const r = await callModuleAction(activityId, 'deletePage', { pageId });
          if (!r.ok) return void toast.error(failed(r));
          toast.success(t('deleted'));
          router.push(back);
          router.refresh();
        });
      }}
    >
      {tc('delete')}
    </Button>
  );
}
