'use client';

import { FormulaError, parseFormula, rewriteRefs } from '@hubium/formula';
import { Button, Field, Textarea } from '@hubium/ui';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@hubium/ui/dialog';
import { toast } from '@hubium/ui/theme';
import { Sigma } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState, useTransition } from 'react';
import { setGradeCalculationAction } from '@/server/actions/grades';

/** What is wrong with a formula as written, checked as the server will, or null. */
function problem(
  src: string,
  ids: string[],
): { key: string; values: Record<string, string | number> } | null {
  if (!src.trim()) return null;
  try {
    parseFormula(src, { dialect: 'gradebook' });
    const known = new Set(ids.map((i) => i.toLowerCase()));
    let unknown: string | null = null;
    rewriteRefs(src, 'gradebook', (r) => {
      if (r.kind === 'idnumber' && !known.has(r.name.trim().toLowerCase()) && unknown === null)
        unknown = r.name;
      return '';
    });
    return unknown === null ? null : { key: 'unknownIdNumber', values: { name: unknown } };
  } catch (e) {
    if (e instanceof FormulaError) return { key: e.code, values: { pos: e.pos + 1 } };
    throw e;
  }
}

/**
 * A manual item's formula: written with [[idnumber]] references to the course's items and
 * categories, checked while typing, the ID numbers a click away.
 */
export function CalculationDialog({
  courseId,
  itemId,
  name,
  formula,
  ids,
}: {
  courseId: string;
  itemId: string;
  name: string;
  /** The current formula as written, or null. */
  formula: string | null;
  /** ID numbers of the course's other items and categories. */
  ids: string[];
}) {
  const t = useTranslations('grades.calc');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState(formula ?? '=');
  const [pending, start] = useTransition();
  const area = useRef<HTMLTextAreaElement>(null);
  // where the caret goes once an inserted reference is rendered: set in the same commit,
  // so a key pressed right after the click lands after the reference
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null) return;
    area.current?.focus();
    area.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  const issue = problem(src, ids);
  const insert = (id: string) => {
    const el = area.current;
    const ref = `[[${id}]]`;
    const at = el?.selectionStart ?? src.length;
    const end = el?.selectionEnd ?? at;
    caret.current = at + ref.length;
    setSrc(src.slice(0, at) + ref + src.slice(end));
  };
  const save = (value: string | null) =>
    start(async () => {
      const r = await setGradeCalculationAction(courseId, itemId, value);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(value ? t('saved') : t('removed'));
      setOpen(false);
      router.refresh();
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setSrc(formula ?? '=');
      }}
    >
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={t('open', { name })} title={t('button')}>
          <Sigma />
        </Button>
      </DialogTrigger>
      <DialogContent title={t('title', { name })} description={t('hint')}>
        <Field
          label={t('label')}
          htmlFor={`calc-${itemId}`}
          error={issue ? t(`errors.${issue.key}`, issue.values) : undefined}
        >
          <Textarea
            ref={area}
            id={`calc-${itemId}`}
            className="min-h-20 font-mono text-sm"
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            aria-invalid={!!issue}
            spellCheck={false}
          />
        </Field>
        <div className="grid gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t('ids')}</p>
          {ids.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {ids.map((id) => (
                <li key={id}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 font-mono text-xs"
                    aria-label={t('insert', { id })}
                    onClick={() => insert(id)}
                  >
                    [[{id}]]
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('noIds')}</p>
          )}
        </div>
        <DialogFooter>
          {formula ? (
            <Button type="button" variant="ghost" disabled={pending} onClick={() => save(null)}>
              {t('remove')}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={pending || !!issue || !src.replace(/^\s*=/, '').trim()}
            onClick={() => save(src)}
          >
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
