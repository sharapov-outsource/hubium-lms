'use client';

import { scanCloze } from '@hubium/questions';
import { cn } from '@hubium/ui/cn';
import { useTranslations } from 'next-intl';
import { useDeferredValue } from 'react';
import type { FieldsProps } from './qtypes-shared';

// Embedded answers (Cloze) are written in the question text: here the syntax, and the
// gaps read from the text as it is typed, with what is wrong with them.

export function ClozeFields({ text = '' }: FieldsProps) {
  const t = useTranslations('qbank.cloze');
  const blocks = scanCloze(useDeferredValue(text));
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
        {
          '{1:SHORTANSWER:=Paris#Right~%50%paris}  {2:NUMERICAL:=3.14:0.01}  {1:MCV:=list~tuple~dict}'
        }
      </pre>
      <p className="text-sm font-medium">{t('preview')}</p>
      <div aria-live="polite" className="grid gap-2">
        {blocks.length ? (
          blocks.map((b, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: gaps are positions in the text
              key={i}
              className={cn(
                'rounded-md border p-2 text-sm',
                b.error ? 'border-destructive/50 text-destructive' : 'border-border',
              )}
              role={b.error ? 'alert' : undefined}
            >
              <span className="font-medium">{t('gap', { n: i + 1 })}</span>
              {b.part ? (
                <>
                  <span className="text-muted-foreground">
                    {' · '}
                    {t(`kinds.${b.part.kind}`)}
                    {' · '}
                    {t('weight', { w: b.part.weight })}
                    {b.part.kind === 'shortanswer' && b.part.caseSensitive
                      ? ` · ${t('caseSensitive')}`
                      : ''}
                  </span>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {b.part.answers.map((a, k) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: answers of one gap
                        key={k}
                        className={cn(
                          'rounded border px-1.5 py-0.5 text-xs',
                          a.fraction >= 1
                            ? 'border-success/60'
                            : a.fraction > 0
                              ? 'border-warning/60'
                              : 'border-border',
                        )}
                      >
                        {'value' in a
                          ? `${a.value}${a.tolerance ? ` ±${a.tolerance}` : ''}`
                          : a.text}{' '}
                        <span className="text-muted-foreground">{pct(a.fraction)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <span>{` · ${t(`errors.${b.code ?? 'noAnswers'}`)}`}</span>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        )}
      </div>
    </div>
  );
}
