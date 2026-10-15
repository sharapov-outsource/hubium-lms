'use client';

import { LocalDateTimeInput, useZonedValue } from '@hubium/module-sdk/form';
import { Button, Checkbox, Input, Label, Select } from '@hubium/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useFieldError } from '@/components/action-form';

// The access restrictions editor of activities and sections (core: courses/availability.ts).

export type Cond =
  | { type: 'date'; op: '>=' | '<'; at: string }
  | { type: 'completion'; activityId: string; state: 'complete' | 'incomplete' | 'pass' | 'fail' }
  | { type: 'group'; groupId?: string }
  | { type: 'grouping'; groupingId: string }
  | { type: 'grade'; activityId: string; min?: number; max?: number }
  | {
      type: 'profile';
      /** Standard field name, or `cf:<shortName>` for a custom profile field. */
      field: string;
      op: string;
      value: string;
    };

const STANDARD_FIELDS = ['email', 'firstName', 'lastName', 'username'] as const;

/** A set of conditions: all of them (`&`) or any (`|`); a set may hold sets of its own. */
export interface AvailabilityValue {
  op: '&' | '|';
  hidden?: boolean;
  c: (Cond | AvailabilityValue)[];
}

/** What the conditions can name in the course. */
export interface AvailabilityOptions {
  /** Activities with completion tracking. */
  activities: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  groupings: { id: string; name: string }[];
  /** Custom profile fields: `cf:<shortName>` and their labels. */
  profileFields: { key: string; label: string }[];
}

const isSet = (n: Cond | AvailabilityValue): n is AvailabilityValue => 'c' in n;

/** Access restrictions of an activity or a section, sent as the `availability` field. */
export function AvailabilityEditor({
  initial,
  activities,
  groups,
  groupings,
  profileFields,
}: { initial: AvailabilityValue | null | undefined } & AvailabilityOptions) {
  const t = useTranslations('activity');
  const id = useId();
  const error = useFieldError('availability');
  // condition dates are shown and picked in the user's profile zone
  const zoned = useZonedValue();
  // sets within the set (from a backup or Moodle) are kept as they are: they are shown and
  // can be removed, not edited here
  const [nodes, setNodes] = useState<(Cond | AvailabilityValue)[]>(initial?.c ?? []);
  const [op, setOp] = useState<'&' | '|'>(initial?.op ?? '&');
  const [hidden, setHidden] = useState(!!initial?.hidden);
  const json = nodes.length
    ? JSON.stringify({
        op,
        hidden,
        // a date cleared in the picker stays empty (the server asks for one)
        c: nodes.map((c) =>
          !isSet(c) && c.type === 'date' && c.at ? { ...c, at: new Date(c.at).toISOString() } : c,
        ),
      })
    : '';
  const update = (i: number, patch: Partial<Cond>) =>
    setNodes((cs) => cs.map((c, j) => (j === i ? ({ ...c, ...patch } as Cond) : c)));
  const remove = (i: number) => setNodes((cs) => cs.filter((_, j) => j !== i));
  const add = (type: Cond['type']) => {
    const first = activities[0]?.id ?? '';
    const next: Cond =
      type === 'date'
        ? { type, op: '>=', at: new Date(Date.now() + 86_400_000).toISOString() }
        : type === 'completion'
          ? { type, activityId: first, state: 'complete' }
          : type === 'group'
            ? { type }
            : type === 'grouping'
              ? { type, groupingId: groupings[0]?.id ?? '' }
              : type === 'grade'
                ? { type, activityId: first, min: 50 }
                : { type, field: 'email', op: 'endsWith', value: '' };
    setNodes((cs) => [...cs, next]);
  };
  return (
    <div className="grid gap-3">
      <input type="hidden" name="availability" value={json} />
      <p className="text-sm text-muted-foreground">{t('accessHint')}</p>
      {nodes.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-op`}>{t('accessOp')}</Label>
          <Select
            id={`${id}-op`}
            className="w-auto"
            value={op}
            onChange={(e) => setOp(e.target.value as '&' | '|')}
          >
            <option value="&">{t('accessAll')}</option>
            <option value="|">{t('accessAny')}</option>
          </Select>
        </div>
      ) : null}
      {nodes.map((c, i) =>
        isSet(c) ? (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids
            key={i}
            className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-sm"
          >
            <span className="flex-1">
              {t(c.op === '|' ? 'nestedAny' : 'nestedAll', { n: c.c.length })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('removeCondition')}
              onClick={() => remove(i)}
            >
              <X />
            </Button>
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids
            key={i}
            className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3"
          >
            <span className="w-full text-xs font-medium text-muted-foreground">
              {t(`conditionTypes.${c.type}`)}
            </span>
            {c.type === 'date' ? (
              <>
                <Select
                  aria-label={t('conditionTypes.date')}
                  className="w-32"
                  value={c.op}
                  onChange={(e) => update(i, { op: e.target.value as '>=' })}
                >
                  <option value=">=">{t('dateFrom')}</option>
                  <option value="<">{t('dateUntil')}</option>
                </Select>
                <LocalDateTimeInput
                  aria-label={t('conditionTypes.date')}
                  className="w-72"
                  value={zoned.toLocal(c.at)}
                  onChange={(v) => update(i, { at: zoned.toIso(v) })}
                />
              </>
            ) : null}
            {c.type === 'completion' || c.type === 'grade' ? (
              <Select
                aria-label={t('conditionTypes.completion')}
                className="min-w-48 flex-1"
                value={c.activityId}
                onChange={(e) => update(i, { activityId: e.target.value })}
              >
                {activities.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            ) : null}
            {c.type === 'completion' ? (
              <Select
                aria-label={t('completion')}
                className="w-56"
                value={c.state}
                onChange={(e) => update(i, { state: e.target.value as 'complete' })}
              >
                {(['complete', 'incomplete', 'pass', 'fail'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`completionStates.${s}`)}
                  </option>
                ))}
              </Select>
            ) : null}
            {c.type === 'grade' ? (
              <>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  aria-label={t('gradeMin')}
                  placeholder={t('gradeMin')}
                  className="w-24"
                  value={c.min ?? ''}
                  onChange={(e) =>
                    update(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
                <Input
                  type="number"
                  min={0}
                  max={100}
                  aria-label={t('gradeMax')}
                  placeholder={t('gradeMax')}
                  className="w-24"
                  value={c.max ?? ''}
                  onChange={(e) =>
                    update(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </>
            ) : null}
            {c.type === 'group' ? (
              <Select
                aria-label={t('conditionTypes.group')}
                className="min-w-48"
                value={c.groupId ?? ''}
                onChange={(e) => update(i, { groupId: e.target.value || undefined })}
              >
                <option value="">{t('anyGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : null}
            {c.type === 'grouping' ? (
              <Select
                aria-label={t('conditionTypes.grouping')}
                className="min-w-48"
                value={c.groupingId}
                onChange={(e) => update(i, { groupingId: e.target.value })}
              >
                {groupings.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            ) : null}
            {c.type === 'profile' ? (
              <>
                <Select
                  aria-label={t('conditionTypes.profile')}
                  className="w-36"
                  value={c.field}
                  onChange={(e) => update(i, { field: e.target.value })}
                >
                  {STANDARD_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {t(`profileFields.${f}`)}
                    </option>
                  ))}
                  {profileFields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t('conditionTypes.profile')}
                  className="w-40"
                  value={c.op}
                  onChange={(e) => update(i, { op: e.target.value })}
                >
                  {(
                    [
                      'equals',
                      'contains',
                      'startsWith',
                      'endsWith',
                      'isEmpty',
                      'isNotEmpty',
                    ] as const
                  ).map((o) => (
                    <option key={o} value={o}>
                      {t(`profileOps.${o}`)}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={t('conditionTypes.profile')}
                  className="w-48"
                  value={c.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('removeCondition')}
              onClick={() => remove(i)}
            >
              <X />
            </Button>
          </div>
        ),
      )}
      <div className="flex flex-wrap gap-2">
        {(['date', 'completion', 'group', 'grouping', 'grade', 'profile'] as const)
          .filter((type) =>
            type === 'completion' || type === 'grade'
              ? activities.length > 0
              : type === 'grouping'
                ? groupings.length > 0
                : true,
          )
          .map((type) => (
            <Button key={type} type="button" variant="outline" size="sm" onClick={() => add(type)}>
              <Plus />
              {t(`conditionTypes.${type}`)}
            </Button>
          ))}
      </div>
      {nodes.length ? (
        <label htmlFor={`${id}-hidden`} className="flex items-center gap-2 text-sm">
          <Checkbox
            id={`${id}-hidden`}
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          {t('hideIfNot')}
        </label>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error.join(', ')}</p> : null}
    </div>
  );
}
