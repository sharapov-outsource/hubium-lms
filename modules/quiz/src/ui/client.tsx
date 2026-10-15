'use client';

import {
  callModuleAction,
  LocalDateTimeInput,
  useConfirm,
  useFailureText,
  useZonedValue,
} from '@hubium/module-sdk/form';
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
  const failed = useFailureText();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(action: string, input: Record<string, unknown>, after?: (data: T) => void) =>
    start(async () => {
      const r = await callModuleAction<T>(activityId, action, input);
      if (!r.ok) return void toast.error(failed(r));
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
  requiresPassword,
}: {
  activityId: string;
  baseUrl: string;
  label: string;
  preview?: boolean;
  /** Ask for the quiz password before starting. */
  requiresPassword?: boolean;
}) {
  const failed = useFailureText();
  const t = useTranslations('mod.quiz');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const id = preview ? 'quiz-password-preview' : 'quiz-password';
  const start = () =>
    startTransition(async () => {
      const r = await callModuleAction<{ attemptId: string }>(activityId, 'start', {
        preview: !!preview,
        ...(requiresPassword ? { password } : {}),
      });
      if (r.ok && r.data) return router.push(`${baseUrl}?attempt=${r.data.attemptId}`);
      // a wrong password is said next to the field, in the user's language
      if (requiresPassword && r.code === 'FORBIDDEN') return setWrong(true);
      toast.error(failed(r));
      router.refresh();
    });
  if (!requiresPassword)
    return (
      <Button
        size="lg"
        className="w-fit"
        variant={preview ? 'secondary' : 'primary'}
        disabled={pending}
        onClick={start}
      >
        {label}
      </Button>
    );
  return (
    <form
      className="grid w-full max-w-sm gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <Field
        label={t('access.enterPassword')}
        htmlFor={id}
        error={wrong ? t('access.wrongPassword') : undefined}
      >
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={password}
          aria-invalid={wrong}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
          }}
          required
        />
      </Field>
      <Button
        type="submit"
        size="lg"
        className="w-fit"
        variant={preview ? 'secondary' : 'primary'}
        disabled={pending || !password}
      >
        {label}
      </Button>
    </form>
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
  slots: { slot: number; page: number; label: string; type: string; maxMark: number }[];
  questions: { id: string; name: string; type: string; categoryId: string }[];
  categories: { id: string; name: string; count: number }[];
}) {
  const t = useTranslations('mod.quiz');
  const { pending, run } = useRun(activityId);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState(categories[0]?.id ?? '');
  const [count, setCount] = useState('1');
  const [subcats, setSubcats] = useState(false);
  const [filter, setFilter] = useState('');
  const [perPage, setPerPage] = useState('1');
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
              <li key={s.slot} className="grid gap-1 py-2">
                {i === 0 || slots[i - 1]!.page !== s.page ? (
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('pages.page', { n: s.page })}
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
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
                </div>
                {i < slots.length - 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-fit text-xs text-muted-foreground"
                    disabled={pending}
                    onClick={() => run('editSlot', { slot: s.slot, op: 'pageBreak' })}
                  >
                    {slots[i + 1]!.page === s.page ? t('pages.addBreak') : t('pages.removeBreak')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
          {slots.length > 1 ? (
            <form
              className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                run('repaginate', { perPage: Number(perPage) || 0 }, () =>
                  toast.success(t('pages.repaginated')),
                );
              }}
            >
              <Field label={t('pages.perPage')} htmlFor="q-perpage">
                <Input
                  id="q-perpage"
                  type="number"
                  min={0}
                  max={100}
                  className="w-24"
                  value={perPage}
                  onChange={(e) => setPerPage(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="outline" disabled={pending}>
                {t('pages.repaginate')}
              </Button>
            </form>
          ) : null}
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
                <label htmlFor="rnd-subcats" className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="rnd-subcats"
                    checked={subcats}
                    onChange={(e) => setSubcats(e.target.checked)}
                  />
                  {t('includeSubcats')}
                </label>
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run('addRandom', {
                      categoryId: cat,
                      count: Number(count) || 1,
                      includeSubcats: subcats,
                    })
                  }
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

/** Dates, time limit or attempts for one participant or the members of one group. */
export function OverrideForm({
  activityId,
  users,
  groups,
}: {
  activityId: string;
  users: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}) {
  const t = useTranslations('mod.quiz');
  const { pending, run } = useRun(activityId);
  const [who, setWho] = useState('');
  const [openAt, setOpenAt] = useState('');
  const [closeAt, setCloseAt] = useState('');
  const [time, setTime] = useState('');
  const [attempts, setAttempts] = useState('');
  const [password, setPassword] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const zoned = useZonedValue();
  const iso = (v: string) => zoned.toIso(v) || null;
  const int = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = () => {
    const [kind, id] = who.split(':');
    run(
      'setOverride',
      {
        ...(kind === 'g' ? { groupId: id } : { userId: id }),
        openAt: iso(openAt),
        closeAt: iso(closeAt),
        timeLimitMin: int(time),
        attempts: int(attempts),
        // '' lifts the quiz password, null keeps it
        password: noPassword ? '' : password || null,
      },
      () => {
        toast.success(t('overrides.saved'));
        setWho('');
      },
    );
  };
  return (
    <div className="grid gap-3">
      <Field label={t('overrides.who')} htmlFor="ov-who">
        <Select id="ov-who" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">{t('overrides.choose')}</option>
          {groups.map((g) => (
            <option key={g.id} value={`g:${g.id}`}>
              {t('overrides.group', { name: g.name })}
            </option>
          ))}
          {users.map((u) => (
            <option key={u.id} value={`u:${u.id}`}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('overrides.openAt')} htmlFor="ov-open">
          <LocalDateTimeInput id="ov-open" value={openAt} onChange={setOpenAt} />
        </Field>
        <Field label={t('overrides.closeAt')} htmlFor="ov-close">
          <LocalDateTimeInput id="ov-close" value={closeAt} onChange={setCloseAt} />
        </Field>
        <Field label={t('overrides.timeLimit')} htmlFor="ov-time">
          <Input
            id="ov-time"
            inputMode="numeric"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </Field>
        <Field label={t('overrides.attempts')} htmlFor="ov-attempts">
          <Input
            id="ov-attempts"
            inputMode="numeric"
            value={attempts}
            onChange={(e) => setAttempts(e.target.value)}
          />
        </Field>
        <Field label={t('access.password')} htmlFor="ov-password">
          <Input
            id="ov-password"
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={noPassword}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <label htmlFor="ov-nopassword" className="flex items-center gap-2 self-end text-sm">
          <Checkbox
            id="ov-nopassword"
            checked={noPassword}
            onChange={(e) => setNoPassword(e.target.checked)}
          />
          {t('overrides.noPassword')}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('overrides.hint')}</p>
      <Button className="w-fit" disabled={pending || !who} onClick={save}>
        {t('overrides.save')}
      </Button>
    </div>
  );
}

export function DeleteOverrideButton({ activityId, id }: { activityId: string; id: string }) {
  const t = useTranslations('common');
  const { pending, run } = useRun(activityId);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() => run('deleteOverride', { id })}
    >
      {t('delete')}
    </Button>
  );
}

interface RegradeReport {
  attempts: {
    attemptId: string;
    userId: string;
    attemptNumber: number;
    before: number;
    after: number;
    maxBefore: number;
    maxAfter: number;
  }[];
  skipped: string[];
}

/** Regrades attempts with the current questions; a dry run only shows what would change. */
export function RegradePanel({
  activityId,
  names,
  gradeMax,
}: {
  activityId: string;
  names: Record<string, string>;
  gradeMax: number;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const t = useTranslations('mod.quiz');
  const { pending, run } = useRun(activityId);
  const [report, setReport] = useState<{ dry: boolean; data: RegradeReport } | null>(null);
  const go = async (dryRun: boolean) => {
    if (!dryRun && !(await confirm(t('regrade.confirm')))) return;
    run<RegradeReport>('regrade', { dryRun }, (data) => {
      setReport({ dry: dryRun, data });
      if (!dryRun) toast.success(t('regrade.done'));
    });
  };
  const points = (v: number, max: number) =>
    max ? `${Math.round((v / max) * gradeMax * 100) / 100}` : '—';
  const changed = report?.data.attempts.filter(
    (x) => x.before !== x.after || x.maxBefore !== x.maxAfter,
  );
  return (
    <>
      {confirmDialog}
      <Card>
        <CardHeader>
          <CardTitle>{t('regrade.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">{t('regrade.hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={pending} onClick={() => go(true)}>
              {t('regrade.dryRun')}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => go(false)}>
              {t('regrade.run')}
            </Button>
          </div>
          {report ? (
            <div className="grid gap-2 text-sm" aria-live="polite">
              <p className="font-medium">
                {t(report.dry ? 'regrade.wouldChange' : 'regrade.changed', {
                  n: changed?.length ?? 0,
                  total: report.data.attempts.length,
                })}
              </p>
              {changed?.length ? (
                <ul className="grid gap-1">
                  {changed.map((x) => (
                    <li key={x.attemptId} className="tabular-nums">
                      {names[x.userId] ?? '—'} · {t('attempt', { n: x.attemptNumber })}:{' '}
                      {points(x.before, x.maxBefore)} → {points(x.after, x.maxAfter)} / {gradeMax}
                    </li>
                  ))}
                </ul>
              ) : null}
              {report.data.skipped.length ? (
                <p className="text-muted-foreground">
                  {t('regrade.skipped', { names: report.data.skipped.join(', ') })}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
