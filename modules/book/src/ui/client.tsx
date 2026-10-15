'use client';

import { EditorField } from '@hubium/editor/field';
import { callModuleAction, useConfirm, useFailureText } from '@hubium/module-sdk/form';
import { Button, Checkbox, Field, Input } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  ListPlus,
  Pencil,
  Plus,
  Printer,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

export function PrintButton({ label }: { label: string }) {
  return (
    <Button onClick={() => window.print()}>
      <Printer aria-hidden />
      {label}
    </Button>
  );
}

export function ChapterForm({
  activityId,
  courseId,
  base,
  chapter,
  afterId,
  subchapter,
  first,
}: {
  activityId: string;
  courseId: string;
  base: string;
  chapter?: { id: string; title: string; content: string };
  afterId?: string | null;
  subchapter: boolean;
  /** The first chapter of the book cannot be a subchapter. */
  first: boolean;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.book');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const input = {
          title: String(fd.get('title') ?? ''),
          content: String(fd.get('content') ?? ''),
          subchapter: fd.get('subchapter') === 'on',
        };
        start(async () => {
          const r = chapter
            ? await callModuleAction<{ id: string }>(activityId, 'updateChapter', {
                ...input,
                id: chapter.id,
              })
            : await callModuleAction<{ id: string }>(activityId, 'addChapter', {
                ...input,
                afterId: afterId ?? null,
              });
          if (!r.ok || !r.data) return void toast.error(failed(r));
          toast.success(t('saved'));
          router.push(`${base}?chapter=${r.data.id}`);
          router.refresh();
        });
      }}
    >
      <Field label={t('chapterTitle')} htmlFor="bk-title">
        <Input id="bk-title" name="title" required maxLength={255} defaultValue={chapter?.title} />
      </Field>
      <EditorField
        name="content"
        label={t('content')}
        defaultValue={chapter?.content}
        courseId={courseId}
        minHeight={320}
      />
      {first ? null : (
        <label htmlFor="bk-sub" className="flex items-center gap-2 text-sm">
          <Checkbox id="bk-sub" name="subchapter" defaultChecked={subchapter} />
          {t('subchapter')}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {tc('save')}
        </Button>
        <Button asChild variant="outline">
          <Link href={chapter ? `${base}?chapter=${chapter.id}` : base}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

export function ChapterTools({
  activityId,
  base,
  chapter,
  first,
  last,
}: {
  activityId: string;
  base: string;
  chapter: { id: string; title: string; hidden: boolean };
  first: boolean;
  last: boolean;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const failed = useFailureText();
  const t = useTranslations('mod.book');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, after?: () => void) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, { id: chapter.id, ...input });
      if (!r.ok) return void toast.error(failed(r));
      after?.();
      router.refresh();
    });
  const icon = 'size-4';
  return (
    <>
      {confirmDialog}
      <div role="toolbar" aria-label={t('chapterTools')} className="flex flex-wrap gap-1">
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}?chapter=${chapter.id}&edit=1`}>
            <Pencil className={icon} aria-hidden />
            {t('editChapter')}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}?add=1&after=${chapter.id}`}>
            <Plus className={icon} aria-hidden />
            {t('addChapter')}
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={`${base}?add=1&after=${chapter.id}&sub=1`}>
            <ListPlus className={icon} aria-hidden />
            {t('addSubchapter')}
          </Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run('setChapterHidden', { hidden: !chapter.hidden })}
        >
          {chapter.hidden ? (
            <Eye className={icon} aria-hidden />
          ) : (
            <EyeOff className={icon} aria-hidden />
          )}
          {chapter.hidden ? t('show') : t('hide')}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('moveUp')}
          disabled={pending || first}
          onClick={() => run('moveChapter', { direction: 'up' })}
        >
          <ArrowUp className={icon} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t('moveDown')}
          disabled={pending || last}
          onClick={() => run('moveChapter', { direction: 'down' })}
        >
          <ArrowDown className={icon} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={async () => {
            if (!(await confirm(t('deleteConfirm', { title: chapter.title })))) return;
            run('deleteChapter', {}, () => {
              toast.success(t('deleted'));
              router.push(base);
            });
          }}
        >
          <Trash2 className={icon} aria-hidden />
          {tc('delete')}
        </Button>
      </div>
    </>
  );
}
