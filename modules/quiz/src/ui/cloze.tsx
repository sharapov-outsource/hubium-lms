'use client';

import { cn } from '@hubium/ui/cn';
import { useTranslations } from 'next-intl';
import type { BodyProps } from './body.ts';
import { GapText } from './gaps.tsx';

// Embedded answers (Cloze): each gap of the text is a field, a list, or a set of radio
// buttons or checkboxes, as its type says.

const field =
  'mx-0.5 inline-block h-8 max-w-full rounded-md border border-input bg-background px-2 align-baseline text-sm disabled:opacity-80 read-only:bg-muted/40';

export function Cloze({ q, value, onChange, readOnly }: BodyProps) {
  const t = useTranslations('mod.quiz');
  const parts = (value.parts as Record<string, string | string[]>) ?? {};
  const set = (place: number, v: string | string[]) =>
    onChange({ parts: { ...parts, [place]: v } });
  return (
    <GapText
      html={q.text}
      renderGap={(place) => {
        const p = q.clozeParts?.find((x) => x.place === place);
        if (!p) return null;
        const id = `q${q.slot}-gap-${place}`;
        const label = t('gaps.gap', { n: place });
        const v = parts[String(place)];
        const options = p.options ?? [];
        if (p.kind === 'shortanswer' || p.kind === 'numerical')
          return (
            <input
              id={id}
              aria-label={label}
              size={p.size}
              inputMode={p.kind === 'numerical' ? 'decimal' : 'text'}
              autoComplete="off"
              spellCheck={false}
              readOnly={readOnly}
              value={typeof v === 'string' ? v : ''}
              onChange={(e) => set(place, e.target.value)}
              className={field}
            />
          );
        if (p.kind === 'multichoice' && p.display === 'dropdown')
          return (
            <select
              id={id}
              aria-label={label}
              disabled={readOnly}
              value={typeof v === 'string' ? v : ''}
              onChange={(e) => set(place, e.target.value)}
              className={field}
            >
              <option value="">{t('choose')}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.text}
                </option>
              ))}
            </select>
          );
        const many = p.kind === 'multiresponse';
        const chosen = new Set(Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
        return (
          <fieldset
            id={id}
            className={cn(
              'mx-0.5 inline-flex gap-x-4 gap-y-1 rounded-md border border-border px-2 py-1 align-middle text-sm',
              p.display === 'horizontal' ? 'flex-wrap' : 'flex-col',
            )}
          >
            <legend className="sr-only">{label}</legend>
            {options.map((o) => (
              <label key={o.id} htmlFor={`${id}-${o.id}`} className="flex items-center gap-2">
                <input
                  id={`${id}-${o.id}`}
                  type={many ? 'checkbox' : 'radio'}
                  name={id}
                  disabled={readOnly}
                  checked={chosen.has(o.id)}
                  onChange={(e) => {
                    if (!many) return set(place, o.id);
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(o.id);
                    else next.delete(o.id);
                    set(place, [...next]);
                  }}
                />
                {o.text}
              </label>
            ))}
          </fieldset>
        );
      }}
    />
  );
}
