'use client';

import { EditorField } from '@hubium/editor/field';
import { callModuleAction, DateInput } from '@hubium/module-sdk/form';
import type { RatingAggregate } from '@hubium/module-sdk/ratings';
import { RatingControl } from '@hubium/module-sdk/ratings-ui';
import { Alert, Button, Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Check, Pencil, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { Field as DataField, FieldType } from '../fields.ts';

/** Adds or changes an entry: an input for each field, files and pictures included. */
export function EntryForm({
  activityId,
  courseId,
  base,
  fields,
  entry,
  files,
}: {
  activityId: string;
  courseId: string;
  base: string;
  fields: DataField[];
  entry?: { id: string; values: Record<string, string> };
  /** Files of the entry by id, to show what a file field holds. */
  files: Record<string, { url: string; name: string }>;
}) {
  const t = useTranslations('mod.data');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const value = (f: DataField) => entry?.values[f.id] ?? '';
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const values: Record<string, string | string[]> = {};
        const list: File[] = [];
        const fileFields: string[] = [];
        const removeFiles: string[] = [];
        for (const f of fields) {
          const key = `v-${f.id}`;
          if (f.type === 'file' || f.type === 'image') {
            const file = fd.get(key);
            if (file instanceof File && file.size > 0) {
              list.push(file);
              fileFields.push(f.id);
            }
            if (fd.get(`remove-${f.id}`) === 'on') removeFiles.push(f.id);
          } else if (f.type === 'checkbox') values[f.id] = fd.getAll(key).map(String);
          else values[f.id] = String(fd.get(key) ?? '');
        }
        start(async () => {
          const r = await callModuleAction<{ id: string; approved: boolean }>(
            activityId,
            'saveEntry',
            { ...(entry ? { id: entry.id } : {}), values, fileFields, removeFiles },
            list.length ? { list } : undefined,
          );
          if (!r.ok || !r.data) return void toast.error(r.message ?? 'Error');
          toast.success(r.data.approved ? t('entry.saved') : t('entry.savedPending'));
          router.push(`${base}?record=${r.data.id}`);
          router.refresh();
        });
      }}
    >
      {fields.map((f) => (
        <FieldInput key={f.id} f={f} value={value(f)} courseId={courseId} files={files} />
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {tc('save')}
        </Button>
        <Button asChild variant="outline">
          <Link href={entry ? `${base}?record=${entry.id}` : base}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

function FieldInput({
  f,
  value,
  courseId,
  files,
}: {
  f: DataField;
  value: string;
  courseId: string;
  files: Record<string, { url: string; name: string }>;
}) {
  const t = useTranslations('mod.data');
  const id = `v-${f.id}`;
  const label = f.required ? `${f.name} *` : f.name;
  const hint = f.description || undefined;
  const choices = f.options.choices ?? [];
  switch (f.type) {
    case 'textarea':
      return (
        <div className="grid gap-1">
          <EditorField
            name={id}
            label={label}
            defaultValue={value}
            courseId={courseId}
            minHeight={160}
          />
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      );
    case 'date':
      return (
        <Field label={label} htmlFor={id} hint={hint}>
          <DateInput id={id} name={id} defaultValue={value || null} />
        </Field>
      );
    case 'menu':
      return (
        <Field label={label} htmlFor={id} hint={hint}>
          <Select id={id} name={id} defaultValue={value}>
            <option value="">—</option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'radio':
    case 'checkbox': {
      const chosen = value.split('\n');
      return (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">{label}</legend>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {choices.map((c, i) => (
            <label key={c} htmlFor={`${id}-${i}`} className="flex items-center gap-2 text-sm">
              {f.type === 'radio' ? (
                <input
                  id={`${id}-${i}`}
                  type="radio"
                  name={id}
                  value={c}
                  defaultChecked={value === c}
                  required={f.required}
                />
              ) : (
                <Checkbox
                  id={`${id}-${i}`}
                  name={id}
                  value={c}
                  defaultChecked={chosen.includes(c)}
                />
              )}
              {c}
            </label>
          ))}
        </fieldset>
      );
    }
    case 'file':
    case 'image': {
      const current = value ? files[value] : undefined;
      return (
        <Field label={label} htmlFor={id} hint={hint}>
          <div className="grid gap-2">
            {current ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <a href={current.url} className="text-accent hover:underline">
                  {current.name}
                </a>
                <label htmlFor={`remove-${f.id}`} className="flex items-center gap-2">
                  <Checkbox id={`remove-${f.id}`} name={`remove-${f.id}`} />
                  {t('entry.removeFile')}
                </label>
              </div>
            ) : null}
            <Input
              id={id}
              name={id}
              type="file"
              accept={f.type === 'image' ? 'image/*' : undefined}
              required={f.required && !current}
            />
          </div>
        </Field>
      );
    }
    default:
      return (
        <Field label={label} htmlFor={id} hint={hint}>
          <Input
            id={id}
            name={id}
            type={f.type === 'url' ? 'url' : 'text'}
            inputMode={f.type === 'number' ? 'decimal' : undefined}
            required={f.required}
            maxLength={f.type === 'url' ? 2000 : 1000}
            defaultValue={value}
          />
        </Field>
      );
  }
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
  entry: { id: string; approved: boolean };
  canEdit: boolean;
  canApprove: boolean;
}) {
  const t = useTranslations('mod.data');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, { id: entry.id, ...input });
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      toast.success(ok);
      after?.();
      router.refresh();
    });
  if (!canEdit && !canApprove) return null;
  return (
    <div role="toolbar" aria-label={t('entryTools')} className="flex flex-wrap gap-1">
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
            <Undo2 className="size-4" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
          {entry.approved ? t('unapprove') : t('approve')}
        </Button>
      ) : null}
      {canEdit ? (
        <>
          <Button asChild size="sm" variant="ghost">
            <Link href={`${base}?edit=${entry.id}`}>
              <Pencil className="size-4" aria-hidden />
              {tc('edit')}
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t('deleteConfirm')))
                run('deleteEntry', {}, t('deleted'), () => router.push(base));
            }}
          >
            <Trash2 className="size-4" aria-hidden />
            {tc('delete')}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** An entry's rating (see RatingControl), rated through the database's "rate" action. */
export function EntryRating({
  activityId,
  recordId,
  authorName,
  kind,
  scale,
  max,
  rating,
}: {
  activityId: string;
  recordId: string;
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
  const t = useTranslations('mod.data.rating');
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <RatingControl
      id={recordId}
      messages="mod.data.rating"
      authorName={authorName}
      kind={kind}
      scale={scale}
      max={max}
      rating={rating}
      pending={pending}
      onRate={(value) =>
        start(async () => {
          const r = await callModuleAction(activityId, 'rate', { recordId, value });
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          toast.success(t('saved'));
          router.refresh();
        })
      }
    />
  );
}

const TYPES: FieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'menu',
  'radio',
  'checkbox',
  'url',
  'file',
  'image',
];

/** Adds a field, or changes one (its kind then stays). */
export function FieldForm({
  activityId,
  base,
  field,
}: {
  activityId: string;
  base: string;
  field?: DataField;
}) {
  const t = useTranslations('mod.data');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const choices = type === 'menu' || type === 'radio' || type === 'checkbox';
  return (
    <form
      className="grid gap-4 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const input = {
          name: String(fd.get('name') ?? ''),
          description: String(fd.get('description') ?? ''),
          required: fd.get('required') === 'on',
          choices: String(fd.get('choices') ?? ''),
          linkText: String(fd.get('linkText') ?? ''),
        };
        start(async () => {
          const r = field
            ? await callModuleAction(activityId, 'updateField', { ...input, id: field.id })
            : await callModuleAction(activityId, 'addField', { ...input, type });
          if (!r.ok) return void toast.error(r.message ?? 'Error');
          toast.success(t('fields.saved'));
          if (field) router.push(`${base}?tab=fields`);
          else form.reset();
          router.refresh();
        });
      }}
    >
      <h3 className="font-medium">
        {field ? t('fields.edit', { name: field.name }) : t('fields.add')}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {field ? null : (
          <Field label={t('fields.type')} htmlFor="df-type">
            <Select
              id="df-type"
              value={type}
              onChange={(e) => setType(e.target.value as FieldType)}
            >
              {TYPES.map((k) => (
                <option key={k} value={k}>
                  {t(`types.${k}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('fields.name')} htmlFor="df-name" hint={t('fields.nameHint')}>
          <Input id="df-name" name="name" required maxLength={255} defaultValue={field?.name} />
        </Field>
      </div>
      <Field label={t('fields.description')} htmlFor="df-description">
        <Input
          id="df-description"
          name="description"
          maxLength={2000}
          defaultValue={field?.description}
        />
      </Field>
      {choices ? (
        <Field label={t('fields.choices')} htmlFor="df-choices" hint={t('fields.choicesHint')}>
          <Textarea
            id="df-choices"
            name="choices"
            rows={4}
            required
            defaultValue={field?.options.choices?.join('\n')}
          />
        </Field>
      ) : null}
      {type === 'url' ? (
        <Field label={t('fields.linkText')} htmlFor="df-linkText" hint={t('fields.linkTextHint')}>
          <Input
            id="df-linkText"
            name="linkText"
            maxLength={255}
            defaultValue={field?.options.linkText}
          />
        </Field>
      ) : null}
      <label htmlFor="df-required" className="flex items-center gap-2 text-sm">
        <Checkbox id="df-required" name="required" defaultChecked={field?.required} />
        {t('fields.required')}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {field ? tc('save') : t('fields.addButton')}
        </Button>
        {field ? (
          <Button asChild variant="outline">
            <Link href={`${base}?tab=fields`}>{tc('cancel')}</Link>
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function FieldTools({
  activityId,
  base,
  field,
  first,
  last,
}: {
  activityId: string;
  base: string;
  field: { id: string; name: string };
  first: boolean;
  last: boolean;
}) {
  const t = useTranslations('mod.data');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, ok?: string) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, { id: field.id, ...input });
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      if (ok) toast.success(ok);
      router.refresh();
    });
  return (
    <div role="toolbar" aria-label={t('fields.tools', { name: field.name })} className="flex gap-1">
      <Button asChild size="icon" variant="ghost" aria-label={tc('edit')}>
        <Link href={`${base}?tab=fields&field=${field.id}`}>
          <Pencil className="size-4" />
        </Link>
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('fields.moveUp')}
        disabled={pending || first}
        onClick={() => run('moveField', { direction: 'up' })}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('fields.moveDown')}
        disabled={pending || last}
        onClick={() => run('moveField', { direction: 'down' })}
      >
        <ArrowDown className="size-4" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={tc('delete')}
        disabled={pending}
        onClick={() => {
          if (window.confirm(t('fields.deleteConfirm', { name: field.name })))
            run('deleteField', {}, t('fields.deleted'));
        }}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

/** Adds entries from a CSV file whose header row names the fields. */
export function ImportEntries({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.data');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{
    created: number;
    errors: { line: number; message: string }[];
    skippedColumns: string[];
  } | null>(null);
  return (
    <div className="grid gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const file = new FormData(e.currentTarget).get('csv');
          if (!(file instanceof File) || !file.size) return;
          start(async () => {
            const r = await callModuleAction<NonNullable<typeof result>>(activityId, 'importCsv', {
              csv: await file.text(),
            });
            if (!r.ok || !r.data) return void toast.error(r.message ?? 'Error');
            setResult(r.data);
            router.refresh();
          });
        }}
      >
        <Field label={t('import.file')} htmlFor="di-csv" hint={t('import.hint')}>
          <Input id="di-csv" name="csv" type="file" accept=".csv,text/csv" required />
        </Field>
        <Button type="submit" disabled={pending}>
          {t('import.run')}
        </Button>
      </form>
      {result ? (
        <Alert variant={result.errors.length ? 'warning' : 'success'}>
          <p>{t('import.created', { n: result.created })}</p>
          {result.skippedColumns.length ? (
            <p>{t('import.skipped', { columns: result.skippedColumns.join(', ') })}</p>
          ) : null}
          {result.errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {result.errors.map((x) => (
                <li key={x.line}>{t('import.error', { line: x.line, message: x.message })}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
