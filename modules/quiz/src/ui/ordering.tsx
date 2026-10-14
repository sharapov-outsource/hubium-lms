'use client';

import { Button } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { BodyProps } from './body.ts';

// An ordering question: items moved with buttons, so it works the same with a mouse, a
// keyboard, a screen reader and a finger. Each move is announced.

function roman(n: number): string {
  const table: [number, string][] = [
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  for (const [v, s] of table)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

/** The label of position `i` (0-based) in a numbering style, or '' for none. */
export function numberLabel(style: string | undefined, i: number): string {
  switch (style) {
    case 'abc':
      return `${String.fromCharCode(97 + (i % 26))}.`;
    case 'ABCD':
      return `${String.fromCharCode(65 + (i % 26))}.`;
    case '123':
      return `${i + 1}.`;
    case 'iii':
      return `${roman(i + 1)}.`;
    case 'IIII':
      return `${roman(i + 1).toUpperCase()}.`;
    default:
      return '';
  }
}

export function Ordering({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz.order');
  const items = q.orderItems ?? [];
  const text = new Map(items.map((i) => [i.id, i.text]));
  const saved = (value.order as string[] | undefined)?.filter((id) => text.has(id)) ?? [];
  const order = [...saved, ...items.map((i) => i.id).filter((id) => !saved.includes(id))];
  const [said, setSaid] = useState('');
  const horizontal = q.orderLayout === 'horizontal';
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    onChange({ order: next });
    setSaid(t('moved', { item: text.get(id!) ?? '', n: to + 1, total: next.length }));
    // the moved item keeps the focus on the same button, if it still can move that way
    requestAnimationFrame(() => {
      const el = document.getElementById(`q${q.slot}-o-${id}-${to > from ? 'later' : 'earlier'}`);
      if (el && !(el as HTMLButtonElement).disabled) el.focus();
      else
        document.getElementById(`q${q.slot}-o-${id}-${to > from ? 'earlier' : 'later'}`)?.focus();
    });
  };
  const Earlier = horizontal ? ArrowLeft : ArrowUp;
  const Later = horizontal ? ArrowRight : ArrowDown;
  return (
    <div className="grid gap-2">
      {readOnly ? null : <p className="text-xs text-muted-foreground">{t('help')}</p>}
      <ol
        aria-label={t('list')}
        className={cn('grid gap-2', horizontal && 'flex flex-wrap items-stretch')}
      >
        {order.map((id, i) => (
          <li
            key={id}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface p-2 text-sm',
              horizontal && 'flex-col items-stretch',
            )}
          >
            <span className="min-w-0 flex-1 break-words px-1">
              {numberLabel(q.orderNumbering, i) ? (
                <span className="mr-1.5 text-muted-foreground">
                  {numberLabel(q.orderNumbering, i)}
                </span>
              ) : null}
              {text.get(id)}
            </span>
            {readOnly ? null : (
              <span className={cn('flex shrink-0 gap-1', horizontal && 'justify-center')}>
                <Button
                  id={`q${q.slot}-o-${id}-earlier`}
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={i === 0}
                  aria-label={t(horizontal ? 'left' : 'up', { item: text.get(id) ?? '' })}
                  onClick={() => move(i, i - 1)}
                >
                  <Earlier />
                </Button>
                <Button
                  id={`q${q.slot}-o-${id}-later`}
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={i === order.length - 1}
                  aria-label={t(horizontal ? 'right' : 'down', { item: text.get(id) ?? '' })}
                  onClick={() => move(i, i + 1)}
                >
                  <Later />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
