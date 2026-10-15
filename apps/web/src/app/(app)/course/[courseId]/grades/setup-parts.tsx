'use client';

import { Button, Checkbox, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { CommandButton } from '@/components/confirm-button';
import {
  deleteGradeCategoryAction,
  deleteScaleAction,
  moveGradebookEntryAction,
  saveGradeCategoryAction,
  saveLettersAction,
  saveScaleAction,
} from '@/server/actions/grades';

const AGGREGATIONS = ['NATURAL', 'MEAN', 'WEIGHTED_MEAN', 'HIGHEST', 'LOWEST', 'MEDIAN'] as const;

export interface CategoryValues {
  id: string;
  parentId: string | null;
  name: string;
  aggregation: string;
  dropLowest: number;
  keepHighest: number;
  onlyGraded: boolean;
  weight: number;
  idNumber: string | null;
}

/** New category, or the settings of an existing one (the root has no parent or weight). */
export function CategoryForm({
  courseId,
  category,
  parents,
}: {
  courseId: string;
  category?: CategoryValues;
  parents: { id: string; label: string; weighted: boolean }[];
}) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  const router = useRouter();
  const sfx = category?.id ?? 'new';
  const isRoot = !!category && !category.parentId;
  const [parentId, setParentId] = useState(category?.parentId ?? parents[0]?.id ?? '');
  // the category's weight counts only in a parent taking a weighted mean
  const weighted = !isRoot && (parents.find((p) => p.id === parentId)?.weighted ?? false);
  return (
    <ActionForm
      action={saveGradeCategoryAction}
      success={tc('saved')}
      resetOnSuccess={!category}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      <input type="hidden" name="courseId" value={courseId} />
      {category ? <input type="hidden" name="id" value={category.id} /> : null}
      {isRoot ? null : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            id={`gc-name-${sfx}`}
            name="name"
            label={t('name')}
            defaultValue={category?.name}
            required
          />
          <FormField id={`gc-parent-${sfx}`} name="parentId" label={t('parent')}>
            <Select
              id={`gc-parent-${sfx}`}
              name="parentId"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              {parents
                .filter((p) => p.id !== category?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </Select>
          </FormField>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id={`gc-agg-${sfx}`} name="aggregation" label={t('aggregation')}>
          <Select
            id={`gc-agg-${sfx}`}
            name="aggregation"
            defaultValue={category?.aggregation ?? 'NATURAL'}
          >
            {AGGREGATIONS.map((a) => (
              <option key={a} value={a}>
                {t(`aggregations.${a}`)}
              </option>
            ))}
          </Select>
        </FormField>
        {weighted ? (
          <FormField
            id={`gc-weight-${sfx}`}
            name="weight"
            type="number"
            step="any"
            min={0}
            label={t('categoryWeight')}
            defaultValue={category?.weight ?? 1}
          />
        ) : (
          // kept for when the parent takes a weighted mean again
          <input type="hidden" name="weight" value={category?.weight ?? 1} />
        )}
        {isRoot ? null : (
          <FormField
            id={`gc-idnumber-${sfx}`}
            name="idNumber"
            label={t('idNumber')}
            hint={t('idNumberHint')}
            defaultValue={category?.idNumber ?? ''}
          />
        )}
        <FormField
          id={`gc-drop-${sfx}`}
          name="dropLowest"
          type="number"
          min={0}
          label={t('dropLowest')}
          defaultValue={category?.dropLowest ?? 0}
        />
        <FormField
          id={`gc-keep-${sfx}`}
          name="keepHighest"
          type="number"
          min={0}
          label={t('keepHighest')}
          defaultValue={category?.keepHighest ?? 0}
        />
      </div>
      <label htmlFor={`gc-only-${sfx}`} className="flex items-center gap-2 text-sm">
        <Checkbox
          id={`gc-only-${sfx}`}
          name="aggregateOnlyGraded"
          defaultChecked={category?.onlyGraded ?? true}
        />
        {t('onlyGraded')}
      </label>
      <SubmitButton className="w-fit" variant={category ? 'secondary' : 'primary'}>
        {category ? tc('save') : tc('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function MoveButtons({
  courseId,
  kind,
  id,
  name,
  first,
  last,
}: {
  courseId: string;
  kind: 'category' | 'item';
  id: string;
  name: string;
  first: boolean;
  last: boolean;
}) {
  const tco = useTranslations('course');
  const router = useRouter();
  const [pending, start] = useTransition();
  const move = (direction: 'up' | 'down') =>
    start(async () => {
      const r = await moveGradebookEntryAction(courseId, kind, id, direction);
      if (!r.ok) toast.error(r.message);
      router.refresh();
    });
  return (
    <span className="inline-flex">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveUp')}: ${name}`}
        disabled={pending || first}
        onClick={() => move('up')}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveDown')}: ${name}`}
        disabled={pending || last}
        onClick={() => move('down')}
      >
        <ArrowDown />
      </Button>
    </span>
  );
}

export function DeleteCategoryButton({
  courseId,
  id,
  name,
}: {
  courseId: string;
  id: string;
  name: string;
}) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  return (
    <CommandButton
      variant="ghost"
      size="sm"
      confirm={t('deleteCategoryConfirm', { name })}
      run={() => deleteGradeCategoryAction(courseId, id)}
    >
      {tc('delete')}
    </CommandButton>
  );
}

/** A scale of a course (courseId) or of the site (courseId null). */
export function ScaleForm({
  courseId,
  scale,
}: {
  courseId: string | null;
  scale?: { id: string; name: string; items: string[]; used: number };
}) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  const router = useRouter();
  const sfx = scale?.id ?? 'new';
  return (
    <ActionForm
      action={saveScaleAction}
      success={tc('saved')}
      resetOnSuccess={!scale}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
      {scale ? <input type="hidden" name="id" value={scale.id} /> : null}
      <FormField
        id={`sc-name-${sfx}`}
        name="name"
        label={t('name')}
        defaultValue={scale?.name}
        required
      />
      <FormField id={`sc-items-${sfx}`} name="items" label={t('scaleItems')}>
        <Textarea
          id={`sc-items-${sfx}`}
          name="items"
          rows={Math.max(3, (scale?.items.length ?? 0) + 1)}
          defaultValue={scale?.items.join('\n')}
          required
        />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant={scale ? 'secondary' : 'primary'}>
          {scale ? tc('save') : tc('create')}
        </SubmitButton>
        {scale ? (
          <>
            <span className="text-xs text-muted-foreground">
              {t('scaleUsed', { count: scale.used })}
            </span>
            {scale.used ? null : (
              <CommandButton
                variant="ghost"
                size="sm"
                confirm={t('deleteScaleConfirm', { name: scale.name })}
                run={() => deleteScaleAction(scale.id, courseId)}
              >
                {tc('delete')}
              </CommandButton>
            )}
          </>
        ) : null}
      </div>
    </ActionForm>
  );
}

/** Letter boundaries of a course (courseId) or of the site; `own` when set there. */
export function LettersForm({
  courseId,
  letters,
  own,
}: {
  courseId: string | null;
  letters: { lowerBound: number; letter: string }[];
  own: boolean;
}) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  const router = useRouter();
  const [rows, setRows] = useState(Math.max(letters.length + 2, 6));
  return (
    <ActionForm
      action={saveLettersAction}
      success={t('lettersSaved')}
      onSuccess={() => router.refresh()}
      className="grid gap-3"
    >
      {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
      <p className="text-sm text-muted-foreground">{t('lettersHint')}</p>
      <div className="grid max-w-sm grid-cols-[1fr_1fr] gap-2 text-sm">
        <span className="font-medium">{t('letter')}</span>
        <span className="font-medium">{t('bound')}</span>
        {Array.from({ length: rows }, (_, i) => {
          const l = letters[i];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions in the form
            <div key={i} className="contents">
              <input
                aria-label={`${t('letter')} ${i + 1}`}
                name={`letter-${i}`}
                defaultValue={l?.letter ?? ''}
                maxLength={20}
                className="h-9 rounded-md border border-input bg-background px-3"
              />
              <input
                aria-label={`${t('bound')} ${i + 1}`}
                name={`bound-${i}`}
                defaultValue={l ? String(l.lowerBound) : ''}
                inputMode="decimal"
                className="h-9 rounded-md border border-input bg-background px-3"
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setRows((r) => r + 2)}>
          {tc('add')}
        </Button>
        <SubmitButton variant="secondary">{tc('save')}</SubmitButton>
        {courseId && own ? (
          <SubmitButton variant="ghost" name="inherit" value="1">
            {t('inherit')}
          </SubmitButton>
        ) : null}
      </div>
    </ActionForm>
  );
}
