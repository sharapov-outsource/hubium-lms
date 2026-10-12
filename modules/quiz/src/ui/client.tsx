'use client';

import { callModuleAction } from '@hubium/module-sdk/form';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Label,
  Select,
} from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

function useRun(activityId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(action: string, input: Record<string, unknown>, after?: (data: T) => void) =>
    start(async () => {
      const r = await callModuleAction<T>(activityId, action, input);
      if (!r.ok) return void toast.error(r.message ?? 'Error');
      after?.(r.data as T);
      router.refresh();
    });
  return { pending, run };
}

export function AttemptActions({
  activityId,
  baseUrl,
  label,
  preview,
}: {
  activityId: string;
  baseUrl: string;
  label: string;
  preview?: boolean;
}) {
  const router = useRouter();
  const { pending, run } = useRun(activityId);
  return (
    <Button
      size="lg"
      className="w-fit"
      variant={preview ? 'secondary' : 'primary'}
      disabled={pending}
      onClick={() =>
        run<{ attemptId: string }>('start', { preview: !!preview }, (d) =>
          router.push(`${baseUrl}?attempt=${d.attemptId}`),
        )
      }
    >
      {label}
    </Button>
  );
}

export function GradeQuestionForm({
  activityId,
  questionAttemptId,
  max,
  mark,
}: {
  activityId: string;
  questionAttemptId: string;
  max: number;
  mark: number | null;
}) {
  const t = useTranslations('mod.quiz');
  const { pending, run } = useRun(activityId);
  const [value, setValue] = useState(mark === null ? '' : String(mark));
  const [comment, setComment] = useState('');
  return (
    <form
      className="grid gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          'gradeQuestion',
          { questionAttemptId, mark: Number(value.replace(',', '.')), comment },
          () => toast.success(t('saved')),
        );
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`${t('mark')} (0–${max})`} htmlFor={`m-${questionAttemptId}`}>
          <Input
            id={`m-${questionAttemptId}`}
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24"
            required
          />
        </Field>
        <Field label={t('comment')} htmlFor={`c-${questionAttemptId}`} className="min-w-56 flex-1">
          <Input
            id={`c-${questionAttemptId}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={pending || value === ''}>
          {t('gradeQuestion')}
        </Button>
      </div>
    </form>
  );
}

export function SlotEditor({
  activityId,
  locked,
  bankUrl,
  slots,
  questions,
  categories,
}: {
  activityId: string;
  locked: boolean;
  bankUrl: string;
  slots: { slot: number; label: string; type: string; maxMark: number }[];
  questions: { id: string; name: string; type: string; categoryId: string }[];
  categories: { id: string; name: string; count: number }[];
}) {
  const t = useTranslations('mod.quiz');
  const { pending, run } = useRun(activityId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState(categories[0]?.id ?? '');
  const [count, setCount] = useState('1');
  const [filter, setFilter] = useState('');
  const shown = questions.filter((q) => q.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>{t('tabs.edit')}</CardTitle>
        </CardHeader>
        <CardContent>
          {slots.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : null}
          <ol className="divide-y divide-border">
            {slots.map((s, i) => (
              <li key={s.slot} className="flex flex-wrap items-center gap-2 py-2">
                <span className="w-6 text-sm tabular-nums text-muted-foreground">{s.slot}</span>
                <span className="min-w-0 flex-1">
                  {s.label} <Badge>{s.type}</Badge>
                </span>
                <label
                  className="flex items-center gap-1 text-xs text-muted-foreground"
                  htmlFor={`mm-${s.slot}`}
                >
                  {t('mark')}
                  <Input
                    id={`mm-${s.slot}`}
                    className="h-8 w-16"
                    defaultValue={s.maxMark}
                    inputMode="decimal"
                    onBlur={(e) => {
                      const v = Number(e.target.value.replace(',', '.'));
                      if (!Number.isNaN(v) && v !== s.maxMark)
                        run('editSlot', { slot: s.slot, op: 'mark', maxMark: v });
                    }}
                  />
                </label>
                {!locked ? (
                  <span className="flex">
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('moveUp')}
                      disabled={pending || i === 0}
                      onClick={() => run('editSlot', { slot: s.slot, op: 'up' })}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('moveDown')}
                      disabled={pending || i === slots.length - 1}
                      onClick={() => run('editSlot', { slot: s.slot, op: 'down' })}
                    >
                      <ArrowDown />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('remove')}
                      disabled={pending}
                      onClick={() => run('editSlot', { slot: s.slot, op: 'remove' })}
                    >
                      <Trash2 />
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      {!locked ? (
        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('addFromBank')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {questions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('bankEmpty')}{' '}
                  <Link href={bankUrl} className="text-accent hover:underline">
                    {t('toBank')}
                  </Link>
                </p>
              ) : (
                <>
                  <Label htmlFor="qfilter" className="sr-only">
                    {t('select')}
                  </Label>
                  <Input
                    id="qfilter"
                    placeholder="…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <ul className="max-h-72 overflow-y-auto">
                    {shown.map((q) => (
                      <li key={q.id}>
                        <label
                          htmlFor={`pk-${q.id}`}
                          className="flex items-center gap-2 py-1 text-sm"
                        >
                          <Checkbox
                            id={`pk-${q.id}`}
                            checked={picked.has(q.id)}
                            onChange={(e) => {
                              const n = new Set(picked);
                              if (e.target.checked) n.add(q.id);
                              else n.delete(q.id);
                              setPicked(n);
                            }}
                          />
                          <span className="truncate">{q.name}</span>
                          <Badge className="ml-auto">{q.type}</Badge>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <Button
                    disabled={!picked.size || pending}
                    onClick={() =>
                      run('addQuestions', { questionIds: [...picked] }, () => setPicked(new Set()))
                    }
                  >
                    {t('add')} ({picked.size})
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
          {categories.length ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('addRandom')}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Field label={t('category')} htmlFor="rnd-cat">
                  <Select id="rnd-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.count})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('count')} htmlFor="rnd-count">
                  <Input
                    id="rnd-count"
                    type="number"
                    min={1}
                    max={100}
                    value={count}
                    onChange={(e) => setCount(e.target.value)}
                  />
                </Field>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run('addRandom', { categoryId: cat, count: Number(count) || 1 })}
                >
                  {t('add')}
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
