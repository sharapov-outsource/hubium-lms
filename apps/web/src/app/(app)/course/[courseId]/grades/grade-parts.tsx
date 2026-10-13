'use client';

import { Alert, Button, Checkbox, Input, Select, Td, Tr } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import {
  createManualItemAction,
  deleteGradeItemAction,
  importGradesAction,
  overrideGradeAction,
  updateGradeItemAction,
} from '@/server/actions/grades';
import { MoveButtons } from './setup-parts';

export function GradeCell({
  courseId,
  itemId,
  userId,
  value,
  shown,
  max,
  scale,
  overridden,
  label,
}: {
  courseId: string;
  itemId: string;
  userId: string;
  value: number | null;
  shown: string;
  max: number;
  /** Grades of the item's scale, worst first. */
  scale?: string[] | null;
  overridden: boolean;
  label: string;
}) {
  const t = useTranslations('grades');
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [pending, start] = useTransition();
  if (scale)
    return (
      <Select
        aria-label={label}
        title={overridden ? t('overridden') : undefined}
        className="h-8 w-36"
        value={value === null ? '' : String(Math.round(value))}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            const next = e.target.value === '' ? null : Number(e.target.value);
            const r = await overrideGradeAction(courseId, itemId, userId, next);
            if (!r.ok) toast.error(r.message);
            else toast.success(t('saved'));
            router.refresh();
          })
        }
      >
        <option value="">—</option>
        {scale.map((s, i) => (
          <option key={s} value={String(i + 1)}>
            {s}
          </option>
        ))}
      </Select>
    );
  const commit = () => {
    const raw = draft.trim().replace(',', '.');
    const next = raw === '' ? null : Number(raw);
    setEditing(false);
    if (next !== null && (Number.isNaN(next) || next < 0 || next > max)) {
      toast.error(`0–${max}`);
      setDraft(value === null ? '' : String(value));
      return;
    }
    if (next === value) return;
    start(async () => {
      const r = await overrideGradeAction(courseId, itemId, userId, next);
      if (!r.ok) toast.error(r.message);
      else toast.success(t('saved'));
      router.refresh();
    });
  };
  if (editing) {
    return (
      <Input
        autoFocus
        aria-label={label}
        className="h-8 w-20"
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(value === null ? '' : String(value));
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`${label}: ${shown}`}
      title={overridden ? t('overridden') : undefined}
      disabled={pending}
      className="h-8 min-w-14 rounded px-1 text-left hover:bg-muted"
      onClick={() => setEditing(true)}
    >
      {shown}
    </button>
  );
}

export function ItemSetupRow({
  courseId,
  item,
  categories,
  first,
  last,
}: {
  courseId: string;
  item: {
    id: string;
    name: string;
    kind: string;
    gradeMax: number;
    weight: number;
    display: string;
    hidden: boolean;
    categoryId: string;
    scale: string | null;
  };
  categories: { id: string; label: string }[];
  first: boolean;
  last: boolean;
}) {
  const t = useTranslations('grades');
  const router = useRouter();
  const [pending, start] = useTransition();
  const patch = (p: Parameters<typeof updateGradeItemAction>[2]) =>
    start(async () => {
      const r = await updateGradeItemAction(courseId, item.id, p);
      if (!r.ok) toast.error(r.message);
      router.refresh();
    });
  return (
    <Tr>
      <Td>
        <span className="flex items-center gap-1">
          <MoveButtons
            courseId={courseId}
            kind="item"
            id={item.id}
            name={item.name}
            first={first}
            last={last}
          />
          <span>
            {item.name}{' '}
            <span className="text-xs text-muted-foreground">
              · {t(`kind.${item.kind}` as 'kind.MODULE')}
            </span>
          </span>
        </span>
      </Td>
      <Td>
        <Select
          aria-label={`${t('category')}: ${item.name}`}
          className="h-8 w-44"
          defaultValue={item.categoryId}
          onChange={(e) => patch({ categoryId: e.target.value })}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </Td>
      <Td className="tabular-nums">{item.scale ?? item.gradeMax}</Td>
      <Td>
        <Input
          aria-label={`${t('weight')}: ${item.name}`}
          className="h-8 w-20"
          defaultValue={item.weight}
          inputMode="decimal"
          disabled={pending}
          onBlur={(e) => {
            const v = Number(e.target.value.replace(',', '.'));
            if (!Number.isNaN(v) && v !== item.weight) patch({ weight: v });
          }}
        />
      </Td>
      <Td>
        <Select
          aria-label={`${t('display')}: ${item.name}`}
          className="h-8 w-36"
          defaultValue={item.display}
          disabled={!!item.scale}
          onChange={(e) => patch({ display: e.target.value as 'REAL' })}
        >
          {(['REAL', 'PERCENT', 'LETTER'] as const).map((d) => (
            <option key={d} value={d}>
              {t(`displays.${d}`)}
            </option>
          ))}
        </Select>
      </Td>
      <Td>
        <Checkbox
          aria-label={`${t('hidden')}: ${item.name}`}
          defaultChecked={item.hidden}
          onChange={(e) => patch({ hidden: e.target.checked })}
        />
      </Td>
      <Td className="text-right">
        {item.kind === 'MANUAL' ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await deleteGradeItemAction(courseId, item.id);
                if (!r.ok) toast.error(r.message);
                router.refresh();
              })
            }
          >
            {t('delete')}
          </Button>
        ) : null}
      </Td>
    </Tr>
  );
}

export function ManualItemForm({
  courseId,
  categories,
  scales,
}: {
  courseId: string;
  categories: { id: string; label: string }[];
  scales: { id: string; name: string }[];
}) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  const [scaleId, setScaleId] = useState('');
  return (
    <ActionForm
      action={createManualItemAction}
      success={tc('saved')}
      resetOnSuccess
      className="grid gap-3"
    >
      <input type="hidden" name="courseId" value={courseId} />
      <FormField name="name" label={t('name')} required />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField name="categoryId" label={t('category')}>
          <Select id="f-categoryId" name="categoryId" defaultValue={categories[0]?.id}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </FormField>
        {scales.length ? (
          <FormField name="scaleId" label={t('scale')}>
            <Select
              id="f-scaleId"
              name="scaleId"
              value={scaleId}
              onChange={(e) => setScaleId(e.target.value)}
            >
              <option value="">{t('points')}</option>
              {scales.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          name="gradeMax"
          type="number"
          label={t('gradeMax')}
          defaultValue="100"
          min={1}
          disabled={!!scaleId}
        />
        <FormField name="gradePass" type="number" label={t('gradePass')} min={0} />
        <FormField
          name="weight"
          type="number"
          label={t('weight')}
          defaultValue="1"
          min={0}
          step="any"
        />
      </div>
      <SubmitButton className="w-fit">{tc('add')}</SubmitButton>
    </ActionForm>
  );
}

export function ImportGradesForm({ courseId }: { courseId: string }) {
  const t = useTranslations('grades');
  const tc = useTranslations('common');
  const [result, setResult] = useState<{
    updated: number;
    errors: { line: number; message: string }[];
  } | null>(null);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('importHint')}</p>
      <ActionForm
        action={importGradesAction}
        onSuccess={(r) => setResult(r)}
        className="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name="courseId" value={courseId} />
        <FormField name="file" type="file" accept=".csv,text/csv" label="CSV" />
        <SubmitButton variant="secondary">{tc('upload')}</SubmitButton>
      </ActionForm>
      {result ? (
        <Alert variant={result.errors.length ? 'warning' : 'success'}>
          {t('importResult', { updated: result.updated, errors: result.errors.length })}
          {result.errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {result.errors.map((e) => (
                <li key={`${e.line}-${e.message}`}>
                  {e.line}: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
