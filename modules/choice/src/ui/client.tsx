'use client';

import { callModuleAction, useConfirm, useFailureText } from '@hubium/module-sdk/form';
import { Button, Checkbox } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

function useRun(activityId: string) {
  const failed = useFailureText();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (action: string, input: Record<string, unknown>, ok?: string) =>
    start(async () => {
      const r = await callModuleAction(activityId, action, input);
      if (!r.ok) return void toast.error(failed(r));
      if (ok) toast.success(ok);
      router.refresh();
    });
  return { pending, run };
}

export function AnswerForm({
  activityId,
  multiple,
  mine,
  options,
}: {
  activityId: string;
  multiple: boolean;
  mine: string[];
  /** `left`: places left when answers are limited. */
  options: { id: string; text: string; left: number | null }[];
}) {
  const t = useTranslations('mod.choice');
  const { pending, run } = useRun(activityId);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const ids = new FormData(e.currentTarget).getAll('option').map(String);
        if (!ids.length) return void toast.error(t('chooseFirst'));
        run('answer', { optionIds: ids }, t('saved'));
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t('options')}</legend>
        {options.map((o) => {
          const full = o.left !== null && o.left <= 0 && !mine.includes(o.id);
          const id = `ch-o-${o.id}`;
          return (
            <label
              key={o.id}
              htmlFor={id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-accent"
            >
              {multiple ? (
                <Checkbox
                  id={id}
                  name="option"
                  value={o.id}
                  defaultChecked={mine.includes(o.id)}
                  disabled={full}
                />
              ) : (
                <input
                  type="radio"
                  id={id}
                  name="option"
                  value={o.id}
                  defaultChecked={mine.includes(o.id)}
                  disabled={full}
                />
              )}
              <span className="flex-1">{o.text}</span>
              {o.left !== null ? (
                <span className="text-xs text-muted-foreground">
                  {full ? t('full') : t('placesLeft', { count: o.left })}
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>
      <Button type="submit" disabled={pending} className="w-fit">
        {mine.length ? t('change') : t('submit')}
      </Button>
    </form>
  );
}

export function Withdraw({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.choice');
  const { pending, run } = useRun(activityId);
  return (
    <Button
      variant="ghost"
      className="w-fit"
      disabled={pending}
      onClick={() => run('withdraw', {}, t('withdrawn'))}
    >
      {t('withdraw')}
    </Button>
  );
}

export function DeleteResponses({
  activityId,
  people,
}: {
  activityId: string;
  people: { id: string; name: string; options: string[] }[];
}) {
  const [confirm, confirmDialog] = useConfirm();
  const t = useTranslations('mod.choice');
  const { pending, run } = useRun(activityId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  return (
    <>
      {confirmDialog}
      <div className="grid gap-3">
        <ul className="grid gap-1">
          {people.map((p) => (
            <li key={p.id}>
              <label htmlFor={`chd-${p.id}`} className="flex items-start gap-2 text-sm">
                <Checkbox
                  id={`chd-${p.id}`}
                  checked={selected.has(p.id)}
                  onChange={(e) => toggle(p.id, e.currentTarget.checked)}
                  className="mt-0.5"
                />
                <span>
                  {p.name} <span className="text-muted-foreground">— {p.options.join(', ')}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <Button
          variant="destructive"
          className="w-fit"
          disabled={pending || !selected.size}
          onClick={async () => {
            if (!(await confirm(t('deleteConfirm', { count: selected.size })))) return;
            run('deleteResponses', { userIds: [...selected] }, t('responsesDeleted'));
            setSelected(new Set());
          }}
        >
          {t('deleteSelected', { count: selected.size })}
        </Button>
      </div>
    </>
  );
}
