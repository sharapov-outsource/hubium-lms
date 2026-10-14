'use client';

import { Button } from '@hubium/ui';
import { cn } from '@hubium/ui/cn';
import { useTranslations } from 'next-intl';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BodyProps } from './body.ts';

// Questions with gaps in their text ([[1]], [[2]], … numbered by place). The text is
// sanitised HTML; a marker element goes where each gap is and the gap's control is
// rendered into it through a portal, so the text itself is never parsed by hand.

const GAP = /\[\[(\d+)\]\]/g;

/** The question text with a control in each gap. */
export function GapText({
  html,
  renderGap,
  className,
}: {
  html: string;
  renderGap: (place: number) => ReactNode;
  className?: string;
}) {
  const marked = useMemo(
    () => html.replace(GAP, (_, n: string) => `<span data-gap="${Number(n)}"></span>`),
    [html],
  );
  const ref = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<[number, HTMLElement][]>([]);
  // the markers are new elements whenever the text changes: find them again
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !marked) return;
    const found = [...root.querySelectorAll<HTMLElement>('span[data-gap]')];
    setSlots(found.map((el) => [Number(el.dataset.gap), el]));
  }, [marked]);
  return (
    <>
      <div
        ref={ref}
        className={cn('prose-content leading-9', className)}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: question text is sanitised on save; only gap markers are added
        dangerouslySetInnerHTML={{ __html: marked }}
      />
      {slots.map(([place, el]) => createPortal(renderGap(place), el, `gap-${place}`))}
    </>
  );
}

type Choice = NonNullable<BodyProps['q']['gapChoices']>[number];

const gapsOf = (value: Record<string, unknown>) => (value.gaps as Record<string, string>) ?? {};

/** Select missing words: a list in each gap with the choices of its group. */
export function GapSelect({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const gaps = gapsOf(value);
  const choices = q.gapChoices ?? [];
  return (
    <GapText
      html={q.text}
      renderGap={(place) => {
        const group = q.gapPlaces?.find((p) => p.place === place)?.group ?? 1;
        return (
          <select
            id={`q${q.slot}-gap-${place}`}
            aria-label={t('gaps.gap', { n: place })}
            disabled={readOnly}
            value={gaps[String(place)] ?? ''}
            onChange={(e) => onChange({ gaps: { ...gaps, [place]: e.target.value } })}
            className="mx-0.5 inline-block h-8 max-w-full rounded-md border border-input bg-background px-2 align-baseline text-sm disabled:opacity-80"
          >
            <option value="">{t('choose')}</option>
            {choices
              .filter((c) => c.group === group)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.text}
                </option>
              ))}
          </select>
        );
      }}
    />
  );
}

// a colour per group, so learners see which answers fit which gaps
const GROUP_TONES = [
  'border-sky-500/70',
  'border-amber-500/70',
  'border-emerald-500/70',
  'border-fuchsia-500/70',
  'border-rose-500/70',
  'border-indigo-500/70',
];
const tone = (group: number) => GROUP_TONES[(group - 1) % GROUP_TONES.length];

/**
 * Drag and drop into text. Pick an answer, then the gap for it (tap, click or keyboard),
 * or drag it there with a mouse. A filled gap clears when picked with no answer in hand.
 * "Answer with lists" turns it into select-missing-words.
 */
export function DragText(props: BodyProps) {
  const { q, value, onChange, readOnly } = props;
  const t = useTranslations('mod.quiz');
  const [lists, setLists] = useState(false);
  const [held, setHeld] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const gaps = gapsOf(value);
  const choices = q.gapChoices ?? [];
  const byId = new Map(choices.map((c) => [c.id, c]));
  const used = new Set(Object.values(gaps));
  const groupOf = (place: number) => q.gapPlaces?.find((p) => p.place === place)?.group ?? 1;

  if (lists) {
    return (
      <div className="grid gap-3">
        <GapSelect {...props} />
        {readOnly ? null : (
          <div>
            <Button type="button" variant="link" size="sm" onClick={() => setLists(false)}>
              {t('gaps.useDrag')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const put = (place: number, id: string | null) => {
    const next = { ...gaps };
    if (id) {
      const c = byId.get(id);
      if (!c || c.group !== groupOf(place)) {
        setSaid(t('gaps.wrongGroup', { n: place }));
        return;
      }
      next[String(place)] = id;
      setSaid(t('gaps.placed', { choice: c.text, n: place }));
    } else {
      delete next[String(place)];
      setSaid(t('gaps.cleared', { n: place }));
    }
    onChange({ gaps: next });
    setHeld(null);
  };

  const card = (c: Choice) => {
    const gone = !c.infinite && used.has(c.id);
    return (
      <button
        key={c.id}
        type="button"
        draggable={!readOnly && !gone}
        disabled={readOnly || gone}
        aria-pressed={held === c.id}
        onClick={() => setHeld((h) => (h === c.id ? null : c.id))}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', c.id);
          e.dataTransfer.effectAllowed = 'move';
          setHeld(c.id);
        }}
        className={cn(
          'rounded-md border-2 bg-surface px-2.5 py-1 text-sm transition-colors',
          tone(c.group),
          held === c.id && 'bg-accent-soft ring-2 ring-ring/50',
          gone ? 'opacity-40' : 'cursor-grab hover:bg-muted',
        )}
      >
        {c.text}
      </button>
    );
  };

  return (
    <div className="grid gap-3">
      <GapText
        html={q.text}
        renderGap={(place) => {
          const filled = byId.get(gaps[String(place)] ?? '');
          return (
            <button
              type="button"
              id={`q${q.slot}-gap-${place}`}
              disabled={readOnly}
              aria-label={`${t('gaps.gap', { n: place })}: ${filled?.text ?? t('gaps.empty')}`}
              onClick={() => (held ? put(place, held) : filled && put(place, null))}
              onDragOver={(e) => {
                if (!readOnly) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/plain');
                if (id) put(place, id);
              }}
              className={cn(
                'mx-0.5 inline-flex h-8 min-w-20 items-center justify-center rounded-md border-2 border-dashed px-2 align-baseline text-sm',
                tone(groupOf(place)),
                filled ? 'border-solid bg-accent-soft' : 'bg-muted/40',
                held && !readOnly && 'ring-2 ring-ring/40',
              )}
            >
              {filled?.text ?? ' '}
            </button>
          );
        }}
      />
      {readOnly ? null : (
        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs font-medium">{t('gaps.bank')}</legend>
          <p className="text-xs text-muted-foreground">{t('gaps.pick')}</p>
          <div className="flex flex-wrap gap-2">{choices.map(card)}</div>
          <div>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0"
              onClick={() => setLists(true)}
            >
              {t('gaps.useLists')}
            </Button>
          </div>
        </fieldset>
      )}
      <p className="sr-only" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
