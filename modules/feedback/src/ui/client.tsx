'use client';

import { callModuleAction } from '@hubium/module-sdk/form';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import { ANSWERED, ITEM_TYPES, type Item, type ItemType } from '../items.ts';

function useRun(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (
    action: string,
    input: Record<string, unknown>,
    opts: { ok?: string; done?: () => void } = {},
  ) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, input);
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      if (opts.ok) toast.success(opts.ok);
      opts.done?.();
      router.refresh();
    });
  return { pending, run };
}

/** The answer of an item from the form, or undefined when none is given. */
function answerOf(fd: FormData, i: Item): unknown {
  if (i.type === 'choice' && i.multiple) {
    const v = fd.getAll(i.id).map(String).filter(Boolean);
    return v.length ? v : undefined;
  }
  const v = fd.get(i.id);
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function Question({ item: i, number }: { item: Item; number?: number }) {
  const t = useTranslations('mod.feedback');
  const label = (
    <>
      {number ? `${number}. ` : ''}
      {i.label}
      {i.required ? (
        <span className="text-destructive" title={t('required')}>
          {' '}
          *<span className="sr-only">({t('required')})</span>
        </span>
      ) : null}
    </>
  );
  const id = `fb-q-${i.id}`;
  if (i.type === 'info') return <p className="whitespace-pre-line text-sm">{i.label}</p>;
  if (i.type === 'choice' && i.display !== 'dropdown')
    return (
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{label}</legend>
        {i.choices.map((c, n) => (
          <label key={c} htmlFor={`${id}-${n}`} className="flex items-center gap-2 text-sm">
            {i.multiple ? (
              <Checkbox id={`${id}-${n}`} name={i.id} value={c} />
            ) : (
              <input type="radio" id={`${id}-${n}`} name={i.id} value={c} />
            )}
            {c}
          </label>
        ))}
      </fieldset>
    );
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {i.type === 'choice' ? (
        <Select id={id} name={i.id} defaultValue="" aria-required={i.required || undefined}>
          <option value="">{t('chooseOption')}</option>
          {i.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      ) : i.type === 'textarea' ? (
        <Textarea
          id={id}
          name={i.id}
          rows={4}
          maxLength={20_000}
          aria-required={i.required || undefined}
        />
      ) : i.type === 'number' ? (
        <Input
          id={id}
          name={i.id}
          type="number"
          step="any"
          min={i.min ?? undefined}
          max={i.max ?? undefined}
          className="w-40"
          aria-required={i.required || undefined}
        />
      ) : (
        <Input id={id} name={i.id} maxLength={1000} aria-required={i.required || undefined} />
      )}
      {i.type === 'number' && (i.min !== null || i.max !== null) ? (
        <p className="text-xs text-muted-foreground">
          {t('range', { min: i.min ?? '−∞', max: i.max ?? '∞' })}
        </p>
      ) : null}
    </div>
  );
}

export function AnswerForm({
  activityId,
  pages,
  numbers,
}: {
  activityId: string;
  pages: Item[][];
  /** Question numbers when the survey numbers its questions. */
  numbers: Record<string, number> | null;
}) {
  const t = useTranslations('mod.feedback');
  const { pending, run } = useRun(activityId);
  const form = useRef<HTMLFormElement>(null);
  const [page, setPage] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  // required questions of a page must be answered before moving on
  const check = (items: Item[]) => {
    const fd = new FormData(form.current!);
    const gaps = items.filter((i) => i.required && answerOf(fd, i) === undefined);
    setMissing(gaps.map((i) => i.id));
    if (gaps.length) toast.error(t('answerRequired'));
    return !gaps.length;
  };
  const last = page === pages.length - 1;
  return (
    <form
      ref={form}
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!check(pages[page]!)) return;
        const fd = new FormData(e.currentTarget);
        const answers: Record<string, unknown> = {};
        for (const i of pages.flat()) {
          const v = answerOf(fd, i);
          if (v !== undefined) answers[i.id] = v;
        }
        run('submit', { answers }, { ok: t('sent') });
      }}
    >
      {pages.length > 1 ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('pageOf', { page: page + 1, pages: pages.length })}
        </p>
      ) : null}
      {pages.map((items, p) => (
        <div key={items[0]!.id} className="grid gap-5" hidden={p !== page}>
          {items.map((i) => (
            <div
              key={i.id}
              className={
                missing.includes(i.id)
                  ? 'rounded-md ring-2 ring-destructive ring-offset-4'
                  : undefined
              }
            >
              <Question item={i} number={numbers?.[i.id]} />
            </div>
          ))}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {page > 0 ? (
          <Button type="button" variant="outline" onClick={() => setPage(page - 1)}>
            {t('back')}
          </Button>
        ) : null}
        {/* distinct keys: reusing the button would turn the click on "next" into a submit */}
        {last ? (
          <Button key="send" type="submit" disabled={pending}>
            {t('send')}
          </Button>
        ) : (
          <Button key="next" type="button" onClick={() => check(pages[page]!) && setPage(page + 1)}>
            {t('next')}
          </Button>
        )}
      </div>
    </form>
  );
}

function ItemForm({
  activityId,
  item,
  onDone,
}: {
  activityId: string;
  item?: Item;
  onDone?: () => void;
}) {
  const t = useTranslations('mod.feedback');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  const [type, setType] = useState<ItemType>(item?.type ?? 'text');
  const [multiple, setMultiple] = useState(item?.multiple ?? false);
  const sfx = item?.id ?? 'new';
  const num = (v: FormDataEntryValue | null) => (v === null || v === '' ? null : Number(v));
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const fd = new FormData(formEl);
        const input = {
          type,
          label: String(fd.get('label') ?? ''),
          required: fd.get('required') === 'on',
          choices: String(fd.get('choices') ?? '')
            .split('\n')
            .map((c) => c.trim())
            .filter(Boolean),
          multiple,
          display: String(fd.get('display') ?? 'radio'),
          min: num(fd.get('min')),
          max: num(fd.get('max')),
        };
        run(item ? 'updateItem' : 'addItem', item ? { ...input, id: item.id } : input, {
          ok: t('itemSaved'),
          done: () => {
            if (!item) formEl.reset();
            onDone?.();
          },
        });
      }}
    >
      <Field label={t('itemType')} htmlFor={`fbi-type-${sfx}`}>
        <Select
          id={`fbi-type-${sfx}`}
          value={type}
          onChange={(e) => setType(e.target.value as ItemType)}
          className="max-w-xs"
        >
          {ITEM_TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`types.${k}`)}
            </option>
          ))}
        </Select>
      </Field>
      {type === 'pagebreak' ? null : (
        <Field label={type === 'info' ? t('infoText') : t('question')} htmlFor={`fbi-label-${sfx}`}>
          <Textarea
            id={`fbi-label-${sfx}`}
            name="label"
            rows={type === 'info' ? 4 : 2}
            maxLength={5000}
            defaultValue={item?.label}
          />
        </Field>
      )}
      {type === 'choice' ? (
        <>
          <Field label={t('choices')} htmlFor={`fbi-choices-${sfx}`}>
            <Textarea
              id={`fbi-choices-${sfx}`}
              name="choices"
              rows={4}
              defaultValue={item?.choices.join('\n')}
            />
          </Field>
          <label htmlFor={`fbi-multiple-${sfx}`} className="flex items-center gap-2 text-sm">
            <Checkbox
              id={`fbi-multiple-${sfx}`}
              checked={multiple}
              onChange={(e) => setMultiple(e.currentTarget.checked)}
            />
            {t('multiple')}
          </label>
          {multiple ? null : (
            <Field label={t('display')} htmlFor={`fbi-display-${sfx}`}>
              <Select
                id={`fbi-display-${sfx}`}
                name="display"
                defaultValue={item?.display ?? 'radio'}
                className="max-w-xs"
              >
                <option value="radio">{t('displayRadio')}</option>
                <option value="dropdown">{t('displayDropdown')}</option>
              </Select>
            </Field>
          )}
        </>
      ) : null}
      {type === 'number' ? (
        <div className="flex flex-wrap gap-3">
          <Field label={t('min')} htmlFor={`fbi-min-${sfx}`}>
            <Input
              id={`fbi-min-${sfx}`}
              name="min"
              type="number"
              step="any"
              className="w-32"
              defaultValue={item?.min ?? ''}
            />
          </Field>
          <Field label={t('max')} htmlFor={`fbi-max-${sfx}`}>
            <Input
              id={`fbi-max-${sfx}`}
              name="max"
              type="number"
              step="any"
              className="w-32"
              defaultValue={item?.max ?? ''}
            />
          </Field>
        </div>
      ) : null}
      {ANSWERED.includes(type) ? (
        <label htmlFor={`fbi-required-${sfx}`} className="flex items-center gap-2 text-sm">
          <Checkbox id={`fbi-required-${sfx}`} name="required" defaultChecked={item?.required} />
          {t('required')}
        </label>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending} variant={item ? 'secondary' : 'primary'}>
          {item ? tc('save') : t('addItem')}
        </Button>
        {item ? (
          <Button type="button" variant="ghost" onClick={onDone}>
            {tc('cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function ItemEditor({
  activityId,
  items,
  numbers,
}: {
  activityId: string;
  items: Item[];
  numbers: Record<string, number>;
}) {
  const t = useTranslations('mod.feedback');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      {items.length ? (
        <ol className="grid gap-2">
          {items.map((i, n) => {
            const name =
              i.type === 'pagebreak'
                ? t('types.pagebreak')
                : `${numbers[i.id] ? `${numbers[i.id]}. ` : ''}${i.label}`;
            return (
              <li key={i.id} className="rounded-lg border border-border p-3">
                {editing === i.id ? (
                  <ItemForm activityId={activityId} item={i} onDone={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="grid min-w-0 flex-1 gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t(`types.${i.type}`)}
                        {i.required ? ` · ${t('required')}` : ''}
                      </span>
                      {i.type === 'pagebreak' ? (
                        <hr className="border-dashed" />
                      ) : (
                        <span className="whitespace-pre-line break-words text-sm">{name}</span>
                      )}
                      {i.type === 'choice' ? (
                        <span className="text-xs text-muted-foreground">
                          {i.choices.join(' · ')}
                        </span>
                      ) : null}
                    </div>
                    <span className="flex gap-1">
                      {i.type === 'pagebreak' ? null : (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t('editItem')}: ${name}`}
                          onClick={() => setEditing(i.id)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('moveUp')}: ${name}`}
                        disabled={pending || n === 0}
                        onClick={() => run('moveItem', { id: i.id, direction: 'up' })}
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('moveDown')}: ${name}`}
                        disabled={pending || n === items.length - 1}
                        onClick={() => run('moveItem', { id: i.id, direction: 'down' })}
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${tc('delete')}: ${name}`}
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(t('deleteItemConfirm')))
                            run('deleteItem', { id: i.id });
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noItems')}</p>
      )}
      <section
        aria-labelledby="fb-new"
        className="grid gap-3 rounded-lg border border-dashed border-border p-4"
      >
        <h3 id="fb-new" className="font-medium">
          {t('newItem')}
        </h3>
        <ItemForm activityId={activityId} />
      </section>
    </div>
  );
}

export function DeleteResponse({ activityId, id }: { activityId: string; id: string }) {
  const t = useTranslations('mod.feedback');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => {
        if (window.confirm(t('deleteResponseConfirm')))
          run('deleteResponse', { id }, { ok: t('responseDeleted') });
      }}
    >
      <Trash2 className="size-4" aria-hidden />
      {tc('delete')}
    </Button>
  );
}
