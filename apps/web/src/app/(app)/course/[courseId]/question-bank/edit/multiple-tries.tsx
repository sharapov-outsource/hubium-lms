'use client';

import { RichTextEditor } from '@hubium/editor/client';
import { useEditorLabels } from '@hubium/editor/field';
import type { Hint } from '@hubium/questions';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Select,
} from '@hubium/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

// The interactive behaviour of quizzes: the penalty for each wrong try and the hints shown
// between tries (as Moodle's "Multiple tries" section).

// as the column keeps them (5 decimals)
const PENALTIES = [1, 0.5, 0.33333, 0.25, 0.2, 0.1, 0];
const MAX_HINTS = 10;

type Draft = Hint & { key: string };

export function MultipleTries({
  penalty,
  hints,
  withParts,
}: {
  penalty: number;
  hints: Hint[];
  /** The type tells right parts apart: its hints can clear wrong ones and count right ones. */
  withParts: boolean;
}) {
  const t = useTranslations('qbank');
  const format = useFormatter();
  const labels = useEditorLabels();
  const base = useId();
  const [list, setList] = useState<Draft[]>(() =>
    hints.map((h, k) => ({ ...h, key: `${base}-${k}` })),
  );
  const [next, setNext] = useState(hints.length);
  const options = PENALTIES.includes(penalty) ? PENALTIES : [...PENALTIES, penalty];
  const update = (key: string, patch: Partial<Hint>) =>
    setList((l) => l.map((h) => (h.key === key ? { ...h, ...patch } : h)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tries.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('tries.about')}</p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <input
          type="hidden"
          name="hints"
          value={JSON.stringify(list.map(({ key: _key, ...h }) => h))}
        />
        <Field label={t('tries.penalty')} htmlFor="f-penalty" className="w-60">
          <Select id="f-penalty" name="penalty" defaultValue={String(penalty)}>
            {options.map((p) => (
              <option key={p} value={String(p)}>
                {format.number(p, { style: 'percent', maximumFractionDigits: 1 })}
              </option>
            ))}
          </Select>
        </Field>
        {list.map((h, k) => (
          <fieldset key={h.key} className="grid gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t('tries.hintN', { n: k + 1 })}</legend>
            <RichTextEditor
              id={`${h.key}-text`}
              name={`hint-${k}`}
              defaultValue={h.text}
              labels={labels}
              ariaLabel={t('tries.hintN', { n: k + 1 })}
              minHeight={60}
              onChangeHtml={(html) => update(h.key, { text: html })}
            />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {withParts ? (
                <>
                  <label htmlFor={`${h.key}-clear`} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`${h.key}-clear`}
                      checked={h.clearWrong}
                      onChange={(e) => update(h.key, { clearWrong: e.target.checked })}
                    />
                    {t('tries.clearWrong')}
                  </label>
                  <label htmlFor={`${h.key}-count`} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`${h.key}-count`}
                      checked={h.showNumCorrect}
                      onChange={(e) => update(h.key, { showNumCorrect: e.target.checked })}
                    />
                    {t('tries.showNumCorrect')}
                  </label>
                </>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setList((l) => l.filter((x) => x.key !== h.key))}
              >
                <Trash2 />
                {t('remove')}
              </Button>
            </div>
          </fieldset>
        ))}
        {list.length < MAX_HINTS ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setList((l) => [
                  ...l,
                  { key: `${base}-${next}`, text: '', clearWrong: false, showNumCorrect: false },
                ]);
                setNext((n) => n + 1);
              }}
            >
              <Plus />
              {t('tries.addHint')}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
