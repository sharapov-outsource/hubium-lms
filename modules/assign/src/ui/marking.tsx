'use client';

import type { Guide, GuideFilling, Rubric, RubricFilling } from '@hubium/module-sdk/grading';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from '@hubium/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { WorkflowState } from '../marking.ts';
import { useAction } from './use-action.ts';

// Marking in the browser: filling a rubric or marking guide (the grade shows as it will be
// stored), defining them, moving students through the marking workflow in bulk, and
// revealing identities after blind marking.

export type FormFill =
  | { method: 'rubric'; definition: Rubric; filling: RubricFilling }
  | { method: 'guide'; definition: Guide; filling: GuideFilling };

/** A rubric to fill: for each criterion one level, as a group of radio buttons. */
export function RubricFill({
  rubric,
  value,
  onChange,
}: {
  rubric: Rubric;
  value: RubricFilling;
  onChange: (v: RubricFilling) => void;
}) {
  const t = useTranslations('mod.assign.rubric');
  return (
    <div className="grid gap-4">
      {rubric.criteria.map((c) => (
        <fieldset key={c.id} className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{c.description}</legend>
          <div className="grid gap-1.5">
            {c.levels.map((l) => (
              <label
                key={l.id}
                htmlFor={`rf-${c.id}-${l.id}`}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/10"
              >
                <input
                  type="radio"
                  id={`rf-${c.id}-${l.id}`}
                  name={`rubric-${c.id}`}
                  value={l.id}
                  className="mt-0.5"
                  checked={value[c.id]?.levelId === l.id}
                  onChange={() =>
                    onChange({
                      ...value,
                      [c.id]: { levelId: l.id, remark: value[c.id]?.remark ?? '' },
                    })
                  }
                />
                <span>
                  {l.definition || '—'}{' '}
                  <span className="whitespace-nowrap text-muted-foreground">
                    ({t('points', { n: l.score })})
                  </span>
                </span>
              </label>
            ))}
          </div>
          <Field label={t('remark')} htmlFor={`rf-${c.id}-remark`}>
            <Textarea
              id={`rf-${c.id}-remark`}
              className="min-h-12 text-sm"
              value={value[c.id]?.remark ?? ''}
              disabled={!value[c.id]}
              onChange={(e) =>
                onChange({
                  ...value,
                  [c.id]: { levelId: value[c.id]?.levelId ?? '', remark: e.target.value },
                })
              }
            />
          </Field>
        </fieldset>
      ))}
    </div>
  );
}

/** A marking guide to fill: a score and a remark for each criterion. */
export function GuideFill({
  guide,
  value,
  onChange,
}: {
  guide: Guide;
  value: GuideFilling;
  onChange: (v: GuideFilling) => void;
}) {
  const t = useTranslations('mod.assign.guide');
  return (
    <div className="grid gap-4">
      {guide.criteria.map((c) => (
        <fieldset key={c.id} className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{c.shortName}</legend>
          {c.descriptionMarkers || c.descriptionStudents ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {c.descriptionMarkers || c.descriptionStudents}
            </p>
          ) : null}
          <Field label={t('scoreOf', { max: c.maxScore })} htmlFor={`gf-${c.id}-score`}>
            <Input
              id={`gf-${c.id}-score`}
              inputMode="decimal"
              className="w-28"
              value={value[c.id] ? String(value[c.id]!.score) : ''}
              onChange={(e) => {
                const raw = e.target.value.replace(',', '.').trim();
                const next = { ...value };
                if (raw === '') delete next[c.id];
                else next[c.id] = { score: Number(raw), remark: value[c.id]?.remark ?? '' };
                onChange(next);
              }}
            />
          </Field>
          <Field label={t('remark')} htmlFor={`gf-${c.id}-remark`}>
            <Textarea
              id={`gf-${c.id}-remark`}
              className="min-h-12 text-sm"
              value={value[c.id]?.remark ?? ''}
              disabled={!value[c.id]}
              onChange={(e) =>
                onChange({
                  ...value,
                  [c.id]: { score: value[c.id]?.score ?? 0, remark: e.target.value },
                })
              }
            />
          </Field>
        </fieldset>
      ))}
    </div>
  );
}

const newId = () => crypto.randomUUID().slice(0, 8);

const emptyRubric = (): Rubric => ({
  criteria: [
    {
      id: newId(),
      description: '',
      levels: [0, 1, 2].map((score) => ({ id: newId(), score, definition: '' })),
    },
  ],
  lockZeroPoints: true,
});

const emptyGuide = (): Guide => ({
  criteria: [
    {
      id: newId(),
      shortName: '',
      descriptionStudents: '',
      descriptionMarkers: '',
      maxScore: 10,
    },
  ],
});

/**
 * The rubric or marking guide editor. Once students have been graded with it, criteria and
 * levels stay (their texts and points may change), as Moodle keeps them.
 */
export function GradingFormEditor({
  activityId,
  method,
  initial,
  used,
}: {
  activityId: string;
  method: 'rubric' | 'guide';
  initial: Rubric | Guide | null;
  used: boolean;
}) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  const [rubric, setRubric] = useState<Rubric>(
    method === 'rubric' && initial ? (initial as Rubric) : emptyRubric(),
  );
  const [guide, setGuide] = useState<Guide>(
    method === 'guide' && initial ? (initial as Guide) : emptyGuide(),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = () =>
    run(
      'saveGradingDefinition',
      { method, definition: method === 'rubric' ? rubric : guide },
      undefined,
      undefined,
      t('rubric.saved'),
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{method === 'rubric' ? t('rubric.title') : t('guide.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {used ? <Alert variant="info">{t('rubric.used')}</Alert> : null}
        {method === 'rubric' ? (
          <RubricEditor value={rubric} onChange={setRubric} locked={used} />
        ) : (
          <GuideEditor value={guide} onChange={setGuide} locked={used} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={pending} onClick={save}>
            {t('rubric.save')}
          </Button>
          {initial ? (
            confirmDelete ? (
              <Alert variant="warning" className="grid w-full gap-2">
                <span>{t('rubric.deleteConfirm')}</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      run('deleteGradingDefinition', { method }, undefined, () =>
                        setConfirmDelete(false),
                      )
                    }
                  >
                    {t('rubric.delete')}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                    ×
                  </Button>
                </div>
              </Alert>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
                {t('rubric.delete')}
              </Button>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function RubricEditor({
  value,
  onChange,
  locked,
}: {
  value: Rubric;
  onChange: (v: Rubric) => void;
  locked: boolean;
}) {
  const t = useTranslations('mod.assign.rubric');
  type Criterion = Rubric['criteria'][number];
  const setCriterion = (i: number, c: Criterion) =>
    onChange({ ...value, criteria: value.criteria.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="grid gap-4">
      {value.criteria.map((c, i) => (
        <fieldset key={c.id} className="grid gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('criterion', { n: i + 1 })}</legend>
          <Field label={t('description')} htmlFor={`re-${c.id}`}>
            <Textarea
              id={`re-${c.id}`}
              className="min-h-12"
              value={c.description}
              onChange={(e) => setCriterion(i, { ...c, description: e.target.value })}
            />
          </Field>
          <ul className="grid gap-2">
            {c.levels.map((l, k) => (
              <li
                key={l.id}
                className="grid gap-2 rounded-md bg-muted/50 p-2 sm:grid-cols-[6rem_1fr_auto] sm:items-end"
              >
                <Field label={t('score')} htmlFor={`re-${c.id}-${l.id}-score`}>
                  <Input
                    id={`re-${c.id}-${l.id}-score`}
                    inputMode="decimal"
                    value={Number.isNaN(l.score) ? '' : String(l.score)}
                    onChange={(e) =>
                      setCriterion(i, {
                        ...c,
                        levels: c.levels.map((x, j) =>
                          j === k ? { ...x, score: Number(e.target.value.replace(',', '.')) } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field label={t('definition')} htmlFor={`re-${c.id}-${l.id}-def`}>
                  <Input
                    id={`re-${c.id}-${l.id}-def`}
                    value={l.definition}
                    onChange={(e) =>
                      setCriterion(i, {
                        ...c,
                        levels: c.levels.map((x, j) =>
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
                  disabled={locked || c.levels.length < 2}
                  aria-label={t('removeLevel', { n: k + 1 })}
                  onClick={() =>
                    setCriterion(i, { ...c, levels: c.levels.filter((_, j) => j !== k) })
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                setCriterion(i, {
                  ...c,
                  levels: [
                    ...c.levels,
                    {
                      id: newId(),
                      score: Math.max(0, ...c.levels.map((l) => l.score)) + 1,
                      definition: '',
                    },
                  ],
                })
              }
            >
              <Plus />
              {t('addLevel')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked || value.criteria.length < 2}
              onClick={() =>
                onChange({ ...value, criteria: value.criteria.filter((_, j) => j !== i) })
              }
            >
              <Trash2 />
              {t('removeCriterion', { n: i + 1 })}
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={locked}
        onClick={() =>
          onChange({ ...value, criteria: [...value.criteria, emptyRubric().criteria[0]!] })
        }
      >
        <Plus />
        {t('addCriterion')}
      </Button>
      <label htmlFor="re-lockzero" className="flex items-start gap-2 text-sm">
        <Checkbox
          id="re-lockzero"
          className="mt-0.5"
          checked={value.lockZeroPoints}
          onChange={(e) => onChange({ ...value, lockZeroPoints: e.target.checked })}
        />
        <span>
          {t('lockZeroPoints')}
          <span className="block text-xs text-muted-foreground">{t('lockZeroPointsHint')}</span>
        </span>
      </label>
    </div>
  );
}

function GuideEditor({
  value,
  onChange,
  locked,
}: {
  value: Guide;
  onChange: (v: Guide) => void;
  locked: boolean;
}) {
  const t = useTranslations('mod.assign.guide');
  type Criterion = Guide['criteria'][number];
  const setCriterion = (i: number, c: Criterion) =>
    onChange({ criteria: value.criteria.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="grid gap-4">
      {value.criteria.map((c, i) => (
        <fieldset key={c.id} className="grid gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('criterion', { n: i + 1 })}</legend>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label={t('shortName')} htmlFor={`ge-${c.id}-name`}>
              <Input
                id={`ge-${c.id}-name`}
                value={c.shortName}
                onChange={(e) => setCriterion(i, { ...c, shortName: e.target.value })}
              />
            </Field>
            <Field label={t('maxScore')} htmlFor={`ge-${c.id}-max`}>
              <Input
                id={`ge-${c.id}-max`}
                inputMode="decimal"
                value={Number.isNaN(c.maxScore) ? '' : String(c.maxScore)}
                onChange={(e) =>
                  setCriterion(i, { ...c, maxScore: Number(e.target.value.replace(',', '.')) })
                }
              />
            </Field>
          </div>
          <Field label={t('descriptionStudents')} htmlFor={`ge-${c.id}-ds`}>
            <Textarea
              id={`ge-${c.id}-ds`}
              className="min-h-12"
              value={c.descriptionStudents}
              onChange={(e) => setCriterion(i, { ...c, descriptionStudents: e.target.value })}
            />
          </Field>
          <Field label={t('descriptionMarkers')} htmlFor={`ge-${c.id}-dm`}>
            <Textarea
              id={`ge-${c.id}-dm`}
              className="min-h-12"
              value={c.descriptionMarkers}
              onChange={(e) => setCriterion(i, { ...c, descriptionMarkers: e.target.value })}
            />
          </Field>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-fit"
            disabled={locked || value.criteria.length < 2}
            onClick={() => onChange({ criteria: value.criteria.filter((_, j) => j !== i) })}
          >
            <Trash2 />
            {t('removeCriterion', { n: i + 1 })}
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        disabled={locked}
        onClick={() => onChange({ criteria: [...value.criteria, emptyGuide().criteria[0]!] })}
      >
        <Plus />
        {t('addCriterion')}
      </Button>
    </div>
  );
}

/**
 * Bulk marking for the students ticked in the list (their checkboxes belong to the form
 * `assign-bulk`): a marking stage, or a marker.
 */
export function BulkMarking({
  activityId,
  states,
  markers,
}: {
  activityId: string;
  states: WorkflowState[];
  /** Markers to allocate, when the user allocates. */
  markers: { id: string; name: string }[] | null;
}) {
  const t = useTranslations('mod.assign');
  const { pending, run } = useAction(activityId);
  const [state, setState] = useState('');
  const [marker, setMarker] = useState('');
  const [none, setNone] = useState(false);
  const chosen = () =>
    [...document.querySelectorAll<HTMLInputElement>('input[form="assign-bulk"][name="users"]')]
      .filter((i) => i.checked)
      .map((i) => i.value);
  const apply = (action: string, input: Record<string, unknown>) => {
    const userIds = chosen();
    if (!userIds.length) {
      setNone(true);
      return;
    }
    setNone(false);
    run(action, { ...input, userIds }, undefined, undefined, t('bulk.done'));
  };
  return (
    <form
      id="assign-bulk"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-3"
      onSubmit={(e) => e.preventDefault()}
      aria-label={t('bulk.title')}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          const boxes = document.querySelectorAll<HTMLInputElement>(
            'input[form="assign-bulk"][name="users"]',
          );
          const all = [...boxes].every((b) => b.checked);
          for (const b of boxes) b.checked = !all;
        }}
      >
        {t('bulk.selectAll')}
      </Button>
      {states.length ? (
        <div className="flex items-end gap-2">
          <Field label={t('workflow.setTo')} htmlFor="bulk-state">
            <Select id="bulk-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">—</option>
              {states.map((s) => (
                <option key={s} value={s}>
                  {t(`workflow.states.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending || !state}
            onClick={() => apply('setWorkflowState', { state })}
          >
            {t('bulk.apply')}
          </Button>
        </div>
      ) : null}
      {markers ? (
        <div className="flex items-end gap-2">
          <Field label={t('allocation.allocateTo')} htmlFor="bulk-marker">
            <Select id="bulk-marker" value={marker} onChange={(e) => setMarker(e.target.value)}>
              <option value="">—</option>
              <option value="none">{t('allocation.none')}</option>
              {markers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={pending || !marker}
            onClick={() => apply('allocateMarker', { markerId: marker === 'none' ? null : marker })}
          >
            {t('bulk.apply')}
          </Button>
        </div>
      ) : null}
      {none ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {t('bulk.noneChosen')}
        </p>
      ) : null}
    </form>
  );
}

/** Reveals who is who after blind marking, once confirmed: it cannot be undone. */
export function RevealIdentities({ activityId }: { activityId: string }) {
  const t = useTranslations('mod.assign.blind');
  const { pending, run } = useAction(activityId);
  const [confirm, setConfirm] = useState(false);
  return confirm ? (
    <div className="grid gap-2">
      <span>{t('revealConfirm')}</span>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() => run('revealIdentities', {}, undefined, undefined, t('revealed'))}
        >
          {t('reveal')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
          ×
        </Button>
      </div>
    </div>
  ) : (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="w-fit"
      onClick={() => setConfirm(true)}
    >
      {t('reveal')}
    </Button>
  );
}
