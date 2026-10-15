'use client';

import { EditorField } from '@hubium/editor/field';
import { callModuleAction, useFailureText } from '@hubium/module-sdk/form';
import type { RatingAggregate } from '@hubium/module-sdk/ratings';
import { RatingControl } from '@hubium/module-sdk/ratings-ui';
import { Button, Checkbox, Field, Input, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { Check, Pencil, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTransition } from 'react';

type Entry = {
  id: string;
  concept: string;
  definition: string;
  aliases: string[];
  categories: string[];
  autoLink: boolean;
  caseSensitive: boolean;
  fullMatch: boolean;
};

export function EntryForm({
  activityId,
  courseId,
  base,
  entry,
  linking,
  categories,
}: {
  activityId: string;
  courseId: string;
  base: string;
  entry?: Entry;
  /** The glossary links concepts, so the entry's linking options apply. */
  linking: boolean;
  /** Categories in use, offered as suggestions. */
  categories: string[];
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.glossary');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const check = (name: 'autoLink' | 'caseSensitive' | 'fullMatch', fallback: boolean) => (
    <label htmlFor={`gle-${name}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`gle-${name}`} name={name} defaultChecked={entry ? entry[name] : fallback} />
      {t(`entry.${name}`)}
    </label>
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        // without linking the options are not shown and keep what they were
        const flag = (name: 'autoLink' | 'caseSensitive' | 'fullMatch', fallback: boolean) =>
          linking ? fd.get(name) === 'on' : (entry?.[name] ?? fallback);
        const input = {
          concept: String(fd.get('concept') ?? ''),
          definition: String(fd.get('definition') ?? ''),
          aliases: String(fd.get('aliases') ?? ''),
          categories: String(fd.get('categories') ?? ''),
          autoLink: flag('autoLink', false),
          caseSensitive: flag('caseSensitive', false),
          fullMatch: flag('fullMatch', true),
        };
        start(async () => {
          const r = entry
            ? await callModuleAction<{ id: string }>(activityId, 'updateEntry', {
                ...input,
                id: entry.id,
              })
            : await callModuleAction<{ id: string; approved: boolean }>(
                activityId,
                'addEntry',
                input,
              );
          if (!r.ok || !r.data) return void toast.error(failed(r));
          toast.success(
            'approved' in r.data && !r.data.approved ? t('entry.savedPending') : t('entry.saved'),
          );
          router.push(`${base}?entry=${r.data.id}`);
          router.refresh();
        });
      }}
    >
      <Field label={t('entry.concept')} htmlFor="gle-concept">
        <Input
          id="gle-concept"
          name="concept"
          required
          maxLength={255}
          defaultValue={entry?.concept}
        />
      </Field>
      <EditorField
        name="definition"
        label={t('entry.definition')}
        defaultValue={entry?.definition}
        courseId={courseId}
        minHeight={200}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('entry.aliases')} htmlFor="gle-aliases" hint={t('entry.aliasesHint')}>
          <Textarea
            id="gle-aliases"
            name="aliases"
            rows={2}
            defaultValue={entry?.aliases.join('\n')}
          />
        </Field>
        <Field
          label={t('entry.categories')}
          htmlFor="gle-categories"
          hint={
            categories.length
              ? t('entry.categoriesInUse', { list: categories.join(', ') })
              : t('entry.categoriesHint')
          }
        >
          <Input
            id="gle-categories"
            name="categories"
            maxLength={2000}
            defaultValue={entry?.categories.join(', ')}
          />
        </Field>
      </div>
      {linking ? (
        <fieldset className="grid gap-2 rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">{t('entry.linking')}</legend>
          {check('autoLink', true)}
          {check('caseSensitive', false)}
          {check('fullMatch', true)}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {tc('save')}
        </Button>
        <Button asChild variant="outline">
          <Link href={entry ? `${base}?entry=${entry.id}` : base}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

export function EntryTools({
  activityId,
  base,
  entry,
  canEdit,
  canApprove,
}: {
  activityId: string;
  base: string;
  entry: { id: string; concept: string; approved: boolean };
  canEdit: boolean;
  canApprove: boolean;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.glossary');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, { id: entry.id, ...input });
      if (!r.ok) return void toast.error(failed(r));
      toast.success(ok);
      after?.();
      router.refresh();
    });
  const icon = 'size-4';
  if (!canEdit && !canApprove) return null;
  return (
    <div
      role="toolbar"
      aria-label={t('entryTools', { concept: entry.concept })}
      className="flex flex-wrap gap-1"
    >
      {canApprove ? (
        <Button
          size="sm"
          variant={entry.approved ? 'ghost' : 'outline'}
          disabled={pending}
          onClick={() =>
            run(
              'approveEntry',
              { approved: !entry.approved },
              entry.approved ? t('unapproved') : t('approved'),
            )
          }
        >
          {entry.approved ? (
            <Undo2 className={icon} aria-hidden />
          ) : (
            <Check className={icon} aria-hidden />
          )}
          {entry.approved ? t('unapprove') : t('approve')}
        </Button>
      ) : null}
      {canEdit ? (
        <>
          <Button asChild size="sm" variant="ghost">
            <Link href={`${base}?edit=${entry.id}`}>
              <Pencil className={icon} aria-hidden />
              {tc('edit')}
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (!window.confirm(t('deleteConfirm', { concept: entry.concept }))) return;
              run('deleteEntry', {}, t('deleted'), () => router.push(base));
            }}
          >
            <Trash2 className={icon} aria-hidden />
            {tc('delete')}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** An entry's rating (see RatingControl), rated through the glossary's "rate" action. */
export function EntryRating({
  activityId,
  entryId,
  authorName,
  kind,
  scale,
  max,
  rating,
}: {
  activityId: string;
  entryId: string;
  authorName: string;
  kind: Exclude<RatingAggregate, 'none'>;
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
  const failed = useFailureText();
  const t = useTranslations('mod.glossary.rating');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <RatingControl
      id={entryId}
      messages="mod.glossary.rating"
      authorName={authorName}
      kind={kind}
      scale={scale}
      max={max}
      rating={rating}
      pending={pending}
      onRate={(value) =>
        start(async () => {
          const r = await callModuleAction(activityId, 'rate', { entryId, value });
          if (!r.ok) return void toast.error(failed(r));
          toast.success(t('saved'));
          router.refresh();
        })
      }
    />
  );
}
