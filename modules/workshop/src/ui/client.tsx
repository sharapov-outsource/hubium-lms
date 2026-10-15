'use client';

import { RichText } from '@hubium/editor/client';
import { EditorField } from '@hubium/editor/field';
import { callModuleAction, useConfirm, useFailureText } from '@hubium/module-sdk/form';
import { Button, Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';
import type { Dimension, Filling, Phase, Strategy } from '../engine.ts';

function useRun(activityId: string) {
  const failed = useFailureText();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(
    action: string,
    input: Record<string, unknown>,
    opts: { ok?: string; files?: File[]; done?: (data: T) => void } = {},
  ) =>
    start(async () => {
      const r = await callModuleAction<T>(
        activityId,
        action,
        input,
        opts.files?.length ? { list: opts.files } : undefined,
      );
      if (!r.ok) return void toast.error(failed(r));
      if (opts.ok) toast.success(opts.ok);
      opts.done?.(r.data as T);
      router.refresh();
    });
  return { pending, run, router };
}

/** The phases, the current one marked; teachers switch to any of them. */
export function PhaseSwitch({
  activityId,
  phase,
  phases,
}: {
  activityId: string;
  phase: Phase;
  phases: Phase[];
}) {
  const [confirm, confirmDialog] = useConfirm();
  const t = useTranslations('mod.workshop');
  const { pending, run } = useRun(activityId);
  return (
    <>
      {confirmDialog}
      <div className="flex flex-wrap gap-1">
        {phases.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={p === phase ? 'secondary' : 'ghost'}
            aria-current={p === phase ? 'step' : undefined}
            disabled={pending || p === phase}
            onClick={async () => {
              if (await confirm(t('switchConfirm', { phase: t(`phases.${p}`) })))
                run('switchPhase', { phase: p }, { ok: t('switched') });
            }}
          >
            {t(`phases.${p}`)}
          </Button>
        ))}
      </div>
    </>
  );
}

/** Hands in the learner's work or changes it. */
export function SubmissionForm({
  activityId,
  courseId,
  base,
  submission,
  files,
  text,
  attach,
  maxAttachments,
}: {
  activityId: string;
  courseId: string;
  base: string;
  submission: { title: string; content: string } | null;
  files: { id: string; name: string; url: string }[];
  text: 'required' | 'optional' | 'off';
  attach: 'required' | 'optional' | 'off';
  maxAttachments: number;
}) {
  const t = useTranslations('mod.workshop');
  const tc = useTranslations('common');
  const { pending, run, router } = useRun(activityId);
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const list = fd.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
        run(
          'submit',
          {
            title: String(fd.get('title') ?? ''),
            content: String(fd.get('content') ?? ''),
            removeFiles: fd.getAll('remove').map(String),
          },
          { ok: t('submitted'), files: list, done: () => router.push(base) },
        );
      }}
    >
      <Field label={t('title')} htmlFor="ws-title">
        <Input
          id="ws-title"
          name="title"
          required
          maxLength={255}
          defaultValue={submission?.title}
        />
      </Field>
      {text === 'off' ? null : (
        <EditorField
          name="content"
          label={text === 'required' ? `${t('content')} *` : t('content')}
          defaultValue={submission?.content}
          courseId={courseId}
          minHeight={240}
        />
      )}
      {attach === 'off' ? null : (
        <Field
          label={t('attachments', { max: maxAttachments })}
          htmlFor="ws-files"
          hint={attach === 'required' ? t('attachmentRequired') : undefined}
        >
          <div className="grid gap-2">
            {files.map((f) => (
              <label
                key={f.id}
                htmlFor={`ws-rm-${f.id}`}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox id={`ws-rm-${f.id}`} name="remove" value={f.id} />
                {t('removeFile', { name: f.name })}
              </label>
            ))}
            <Input id="ws-files" name="files" type="file" multiple={maxAttachments > 1} />
          </div>
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {t('submitWork')}
        </Button>
        <Button asChild variant="outline">
          <Link href={base}>{tc('cancel')}</Link>
        </Button>
      </div>
    </form>
  );
}

/** The assessment form of the workshop's strategy, filled in or shown. */
export function AssessmentForm({
  activityId,
  base,
  strategy,
  dimensions,
  assessmentId,
  submissionId,
  filling,
  feedback,
  readOnly,
}: {
  activityId: string;
  base: string;
  strategy: Strategy;
  dimensions: Dimension[];
  assessmentId: string | null;
  submissionId: string;
  filling: Filling;
  feedback: string;
  readOnly: boolean;
}) {
  const t = useTranslations('mod.workshop');
  const { pending, run, router } = useRun(activityId);
  const [values, setValues] = useState<Filling>(filling);
  const set = (id: string, patch: Filling[string]) =>
    setValues((v) => ({ ...v, [id]: { ...v[id], ...patch } }));
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run(
          'assess',
          {
            ...(assessmentId ? { assessmentId } : { submissionId }),
            filling: values,
            feedbackAuthor: String(fd.get('feedbackAuthor') ?? ''),
          },
          { ok: t('assessed'), done: () => router.push(base) },
        );
      }}
    >
      {dimensions.map((d, i) => {
        const v = values[d.id] ?? {};
        const id = `wa-${d.id}`;
        return (
          <fieldset
            key={d.id}
            className="grid gap-3 rounded-lg border border-border p-4"
            disabled={readOnly}
          >
            <legend className="px-1 text-sm font-medium">
              {t(
                strategy === 'comments'
                  ? 'aspect'
                  : strategy === 'numerrors'
                    ? 'assertion'
                    : 'criterion',
                {
                  n: i + 1,
                },
              )}
            </legend>
            <RichText html={d.description} className="text-sm" />
            {strategy === 'accumulative' ? (
              <Field label={t('gradeOutOf', { max: d.maxGrade ?? 0 })} htmlFor={`${id}-g`}>
                <Input
                  id={`${id}-g`}
                  type="number"
                  min={0}
                  max={d.maxGrade}
                  step="any"
                  required
                  className="w-32"
                  value={v.grade ?? ''}
                  onChange={(e) =>
                    set(d.id, { grade: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </Field>
            ) : strategy === 'numerrors' ? (
              <div className="flex flex-wrap gap-4 text-sm">
                {[true, false].map((b) => (
                  <label key={String(b)} htmlFor={`${id}-${b}`} className="flex items-center gap-2">
                    <input
                      id={`${id}-${b}`}
                      type="radio"
                      name={id}
                      required
                      checked={v.passed === b}
                      onChange={() => set(d.id, { passed: b })}
                    />
                    {b ? d.positive || t('yes') : d.negative || t('no')}
                  </label>
                ))}
              </div>
            ) : strategy === 'rubric' ? (
              <div className="grid gap-1.5 text-sm">
                {(d.levels ?? []).map((l) => (
                  <label key={l.id} htmlFor={`${id}-${l.id}`} className="flex items-start gap-2">
                    <input
                      id={`${id}-${l.id}`}
                      type="radio"
                      name={id}
                      required
                      className="mt-1"
                      checked={v.levelId === l.id}
                      onChange={() => set(d.id, { levelId: l.id })}
                    />
                    <span>
                      {l.definition || '—'}{' '}
                      <span className="text-muted-foreground">({l.grade})</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            <Field label={t('comment')} htmlFor={`${id}-c`}>
              <Textarea
                id={`${id}-c`}
                rows={2}
                maxLength={10_000}
                required={strategy === 'comments'}
                value={v.comment ?? ''}
                onChange={(e) => set(d.id, { comment: e.target.value })}
              />
            </Field>
          </fieldset>
        );
      })}
      <Field label={t('feedbackAuthor')} htmlFor="wa-feedback">
        <Textarea
          id="wa-feedback"
          name="feedbackAuthor"
          rows={4}
          maxLength={100_000}
          defaultValue={feedback}
          disabled={readOnly}
        />
      </Field>
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {t('saveAssessment')}
          </Button>
        </div>
      )}
    </form>
  );
}

type EditDim = Dimension & { key: number };

/** The teacher writes the assessment form of the chosen strategy. */
export function FormEditor({
  activityId,
  strategy,
  dimensions,
  mapping,
  locked,
}: {
  activityId: string;
  strategy: Strategy;
  dimensions: Dimension[];
  mapping: Record<string, number>;
  locked: boolean;
}) {
  const t = useTranslations('mod.workshop');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  const keys = useRef(0);
  const blank = (): EditDim => ({
    key: keys.current++,
    id: '',
    description: '',
    maxGrade: 10,
    weight: 1,
    levels:
      strategy === 'rubric'
        ? [
            { id: '', grade: 0, definition: '' },
            { id: '', grade: 1, definition: '' },
          ]
        : undefined,
  });
  const [dims, setDims] = useState<EditDim[]>(() =>
    dimensions.length ? dimensions.map((d) => ({ ...d, key: keys.current++ })) : [blank()],
  );
  const [map, setMap] = useState(() =>
    Object.entries(mapping)
      .map(([k, v]) => ({ errors: k, grade: String(v) }))
      .sort((x, y) => Number(x.errors) - Number(y.errors)),
  );
  const set = (key: number, patch: Partial<Dimension>) =>
    setDims((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const noun =
    strategy === 'comments' ? 'aspect' : strategy === 'numerrors' ? 'assertion' : 'criterion';
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          'saveForm',
          {
            dimensions: dims.map(({ key: _k, ...d }) => d),
            mapping: Object.fromEntries(
              map
                .filter((m) => m.errors !== '' && m.grade !== '')
                .map((m) => [m.errors, Number(m.grade)]),
            ),
          },
          { ok: t('form.saved') },
        );
      }}
    >
      <p className="text-sm text-muted-foreground">{t(`form.about.${strategy}`)}</p>
      {dims.map((d, i) => (
        <fieldset
          key={d.key}
          className="grid gap-3 rounded-lg border border-border p-4"
          disabled={locked}
        >
          <legend className="px-1 text-sm font-medium">{t(noun, { n: i + 1 })}</legend>
          <Field label={t('form.description')} htmlFor={`wf-d-${d.key}`}>
            <Textarea
              id={`wf-d-${d.key}`}
              rows={2}
              required
              value={d.description}
              onChange={(e) => set(d.key, { description: e.target.value })}
            />
          </Field>
          {strategy === 'accumulative' || strategy === 'numerrors' ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {strategy === 'accumulative' ? (
                <Field label={t('form.maxGrade')} htmlFor={`wf-m-${d.key}`}>
                  <Input
                    id={`wf-m-${d.key}`}
                    type="number"
                    min={1}
                    max={1000}
                    required
                    value={d.maxGrade ?? ''}
                    onChange={(e) => set(d.key, { maxGrade: Number(e.target.value) })}
                  />
                </Field>
              ) : (
                <>
                  <Field label={t('form.positive')} htmlFor={`wf-p-${d.key}`}>
                    <Input
                      id={`wf-p-${d.key}`}
                      value={d.positive ?? ''}
                      placeholder={t('yes')}
                      onChange={(e) => set(d.key, { positive: e.target.value })}
                    />
                  </Field>
                  <Field label={t('form.negative')} htmlFor={`wf-n-${d.key}`}>
                    <Input
                      id={`wf-n-${d.key}`}
                      value={d.negative ?? ''}
                      placeholder={t('no')}
                      onChange={(e) => set(d.key, { negative: e.target.value })}
                    />
                  </Field>
                </>
              )}
              <Field label={t('form.weight')} htmlFor={`wf-w-${d.key}`}>
                <Input
                  id={`wf-w-${d.key}`}
                  type="number"
                  min={0}
                  max={16}
                  value={d.weight ?? 1}
                  onChange={(e) => set(d.key, { weight: Number(e.target.value) })}
                />
              </Field>
            </div>
          ) : null}
          {strategy === 'rubric' ? (
            <div className="grid gap-2">
              {(d.levels ?? []).map((l, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: controlled inputs; their values live in state
                <div key={k} className="grid items-end gap-2 sm:grid-cols-[6rem_1fr_auto]">
                  <Field label={t('form.levelGrade', { n: k + 1 })} htmlFor={`wf-lg-${d.key}-${k}`}>
                    <Input
                      id={`wf-lg-${d.key}-${k}`}
                      type="number"
                      step="any"
                      value={l.grade}
                      onChange={(e) =>
                        set(d.key, {
                          levels: d.levels!.map((x, j) =>
                            j === k ? { ...x, grade: Number(e.target.value) } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field
                    label={t('form.levelDefinition', { n: k + 1 })}
                    htmlFor={`wf-ld-${d.key}-${k}`}
                  >
                    <Input
                      id={`wf-ld-${d.key}-${k}`}
                      value={l.definition}
                      onChange={(e) =>
                        set(d.key, {
                          levels: d.levels!.map((x, j) =>
                            j === k ? { ...x, definition: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('form.removeLevel', { n: k + 1 })}
                    disabled={(d.levels?.length ?? 0) <= 2}
                    onClick={() => set(d.key, { levels: d.levels!.filter((_, j) => j !== k) })}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() =>
                  set(d.key, {
                    levels: [
                      ...(d.levels ?? []),
                      { id: '', grade: d.levels?.length ?? 0, definition: '' },
                    ],
                  })
                }
              >
                <Plus aria-hidden />
                {t('form.addLevel')}
              </Button>
            </div>
          ) : null}
          {dims.length > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="justify-self-start"
              onClick={() => setDims((ds) => ds.filter((x) => x.key !== d.key))}
            >
              <Trash2 aria-hidden />
              {tc('delete')}
            </Button>
          ) : null}
        </fieldset>
      ))}
      {locked ? null : (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => setDims((ds) => [...ds, blank()])}
        >
          <Plus aria-hidden />
          {t(`form.add.${noun}`)}
        </Button>
      )}
      {strategy === 'numerrors' ? (
        <fieldset className="grid gap-2 rounded-lg border border-border p-4" disabled={locked}>
          <legend className="px-1 text-sm font-medium">{t('form.mapping')}</legend>
          <p className="text-xs text-muted-foreground">{t('form.mappingHint')}</p>
          {map.map((m, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: controlled inputs; their values live in state
            <div key={k} className="grid items-end gap-2 sm:grid-cols-[8rem_8rem_auto]">
              <Field label={t('form.errors')} htmlFor={`wf-me-${k}`}>
                <Input
                  id={`wf-me-${k}`}
                  type="number"
                  min={0}
                  value={m.errors}
                  onChange={(e) =>
                    setMap((ms) =>
                      ms.map((x, j) => (j === k ? { ...x, errors: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label={t('form.percent')} htmlFor={`wf-mg-${k}`}>
                <Input
                  id={`wf-mg-${k}`}
                  type="number"
                  min={0}
                  max={100}
                  value={m.grade}
                  onChange={(e) =>
                    setMap((ms) =>
                      ms.map((x, j) => (j === k ? { ...x, grade: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={tc('delete')}
                onClick={() => setMap((ms) => ms.filter((_, j) => j !== k))}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="justify-self-start"
            onClick={() => setMap((ms) => [...ms, { errors: String(ms.length + 1), grade: '' }])}
          >
            <Plus aria-hidden />
            {t('form.addMapping')}
          </Button>
        </fieldset>
      ) : null}
      {locked ? null : (
        <Button type="submit" disabled={pending} className="justify-self-start">
          {t('form.save')}
        </Button>
      )}
    </form>
  );
}

/** Manual allocation: a submission's reviewers, added and taken back. */
export function AllocationRow({
  activityId,
  submissionId,
  reviewers,
  candidates,
}: {
  activityId: string;
  submissionId: string;
  reviewers: { assessmentId: string; name: string; assessed: boolean }[];
  candidates: { id: string; name: string }[];
}) {
  const [confirm, confirmDialog] = useConfirm();
  const t = useTranslations('mod.workshop');
  const { pending, run } = useRun(activityId);
  const [pick, setPick] = useState('');
  return (
    <>
      {confirmDialog}
      <div className="grid gap-2">
        <ul className="flex flex-wrap gap-1 text-sm">
          {reviewers.map((r) => (
            <li
              key={r.assessmentId}
              className="flex items-center gap-1 rounded-full border border-border py-0.5 pl-2.5 pr-1"
            >
              {r.name}
              {r.assessed ? ' ✓' : ''}
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label={t('allocation.remove', { name: r.name })}
                disabled={pending}
                onClick={async () => {
                  if (!r.assessed || (await confirm(t('allocation.removeAssessed'))))
                    run('deallocate', { assessmentId: r.assessmentId });
                }}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        {candidates.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('allocation.reviewer')}
              className="w-56"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{t('allocation.choose')}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !pick}
              onClick={() =>
                run('allocate', { submissionId, reviewerId: pick }, { done: () => setPick('') })
              }
            >
              {t('allocation.add')}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function RandomAllocation({ activityId, groups }: { activityId: string; groups: boolean }) {
  const t = useTranslations('mod.workshop');
  const { pending, run } = useRun(activityId);
  return (
    <form
      className="grid gap-3 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run<{ allocated: number }>(
          'randomAllocate',
          {
            count: Number(fd.get('count')),
            per: String(fd.get('per') ?? 'submission'),
            excludeSameGroup: fd.get('excludeSameGroup') === 'on',
            addSelf: fd.get('addSelf') === 'on',
            removeCurrent: fd.get('removeCurrent') === 'on',
          },
          { done: (d) => toast.success(t('allocation.done', { n: d.allocated })) },
        );
      }}
    >
      <h3 className="font-medium">{t('allocation.random')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('allocation.count')} htmlFor="wr-count">
          <Input
            id="wr-count"
            name="count"
            type="number"
            min={1}
            max={30}
            defaultValue={3}
            required
          />
        </Field>
        <Field label={t('allocation.per')} htmlFor="wr-per">
          <Select id="wr-per" name="per" defaultValue="submission">
            <option value="submission">{t('allocation.perSubmission')}</option>
            <option value="reviewer">{t('allocation.perReviewer')}</option>
          </Select>
        </Field>
      </div>
      {groups ? (
        <label htmlFor="wr-groups" className="flex items-center gap-2 text-sm">
          <Checkbox id="wr-groups" name="excludeSameGroup" />
          {t('allocation.excludeSameGroup')}
        </label>
      ) : null}
      <label htmlFor="wr-self" className="flex items-center gap-2 text-sm">
        <Checkbox id="wr-self" name="addSelf" />
        {t('allocation.addSelf')}
      </label>
      <label htmlFor="wr-remove" className="flex items-center gap-2 text-sm">
        <Checkbox id="wr-remove" name="removeCurrent" />
        {t('allocation.removeCurrent')}
      </label>
      <Button type="submit" disabled={pending} className="justify-self-start">
        {t('allocation.run')}
      </Button>
    </form>
  );
}

export function CalculateGrades({
  activityId,
  comparison,
}: {
  activityId: string;
  comparison: number;
}) {
  const t = useTranslations('mod.workshop');
  const { pending, run } = useRun(activityId);
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          'calculateGrades',
          { comparison: Number(new FormData(e.currentTarget).get('comparison')) },
          { ok: t('calculated') },
        );
      }}
    >
      <Field label={t('comparison')} htmlFor="wc-comparison">
        <Select
          id="wc-comparison"
          name="comparison"
          defaultValue={String(comparison)}
          className="w-48"
        >
          {[9, 7, 5, 3, 1].map((c) => (
            <option key={c} value={c}>
              {t(`comparisons.${c}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        {t('calculate')}
      </Button>
    </form>
  );
}

/** The teacher's grade, feedback and publishing of a submission (points of the grade). */
export function GradeSubmission({
  activityId,
  submissionId,
  gradeMax,
  gradeOver,
  feedback,
  published,
}: {
  activityId: string;
  submissionId: string;
  gradeMax: number;
  gradeOver: number | null;
  feedback: string;
  published: boolean;
}) {
  const t = useTranslations('mod.workshop');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  const points = (pct: number | null) => (pct === null ? '' : Math.round(pct * gradeMax) / 100);
  return (
    <form
      className="grid gap-3 rounded-lg border border-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const raw = String(fd.get('gradeOver') ?? '');
        run(
          'gradeSubmission',
          {
            submissionId,
            gradeOver:
              raw === '' || gradeMax <= 0 ? null : Math.min(100, (Number(raw) / gradeMax) * 100),
            feedback: String(fd.get('feedback') ?? ''),
            published: fd.get('published') === 'on',
          },
          { ok: t('saved') },
        );
      }}
    >
      <h3 className="font-medium">{t('teacherGrade')}</h3>
      <Field label={t('gradeOver', { max: gradeMax })} htmlFor="wg-over" hint={t('gradeOverHint')}>
        <Input
          id="wg-over"
          name="gradeOver"
          type="number"
          min={0}
          max={gradeMax}
          step="any"
          className="w-32"
          defaultValue={points(gradeOver)}
        />
      </Field>
      <Field label={t('feedbackToAuthor')} htmlFor="wg-feedback">
        <Textarea id="wg-feedback" name="feedback" rows={3} defaultValue={feedback} />
      </Field>
      <label htmlFor="wg-published" className="flex items-center gap-2 text-sm">
        <Checkbox id="wg-published" name="published" defaultChecked={published} />
        {t('publish')}
      </label>
      <Button type="submit" disabled={pending} className="justify-self-start">
        {tc('save')}
      </Button>
    </form>
  );
}

/** The teacher weighs an assessment and grades it. */
export function GradeAssessment({
  activityId,
  assessmentId,
  weight,
  gradingGradeOver,
  gradingGradeMax,
  feedbackReviewer,
}: {
  activityId: string;
  assessmentId: string;
  weight: number;
  gradingGradeOver: number | null;
  gradingGradeMax: number;
  feedbackReviewer: string;
}) {
  const t = useTranslations('mod.workshop');
  const tc = useTranslations('common');
  const { pending, run } = useRun(activityId);
  return (
    <form
      className="grid gap-3 sm:grid-cols-[7rem_10rem_1fr_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const raw = String(fd.get('over') ?? '');
        run(
          'gradeAssessment',
          {
            assessmentId,
            weight: Number(fd.get('weight')),
            gradingGradeOver:
              raw === '' || gradingGradeMax <= 0
                ? null
                : Math.min(100, (Number(raw) / gradingGradeMax) * 100),
            feedbackReviewer: String(fd.get('feedbackReviewer') ?? ''),
          },
          { ok: t('saved') },
        );
      }}
    >
      <Field label={t('weight')} htmlFor={`wga-w-${assessmentId}`}>
        <Input
          id={`wga-w-${assessmentId}`}
          name="weight"
          type="number"
          min={0}
          max={16}
          defaultValue={weight}
        />
      </Field>
      <Field
        label={t('gradingGradeOver', { max: gradingGradeMax })}
        htmlFor={`wga-o-${assessmentId}`}
      >
        <Input
          id={`wga-o-${assessmentId}`}
          name="over"
          type="number"
          min={0}
          max={gradingGradeMax}
          step="any"
          defaultValue={
            gradingGradeOver === null ? '' : Math.round(gradingGradeOver * gradingGradeMax) / 100
          }
        />
      </Field>
      <Field label={t('feedbackToReviewer')} htmlFor={`wga-f-${assessmentId}`}>
        <Input
          id={`wga-f-${assessmentId}`}
          name="feedbackReviewer"
          defaultValue={feedbackReviewer}
        />
      </Field>
      <Button type="submit" disabled={pending}>
        {tc('save')}
      </Button>
    </form>
  );
}
