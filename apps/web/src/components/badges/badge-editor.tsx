'use client';

import { Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { saveBadgeAction } from '@/server/actions/badges';

type Method = 'all' | 'any';
type Option = { id: string; name: string };

export interface BadgeEditorOptions {
  activities: Option[];
  roles: Option[];
  courses: Option[];
  cohorts: Option[];
}

interface ListRule {
  ids: string[];
  method: Method;
}

interface State {
  method: Method;
  courseCompletion: boolean;
  courseGrade: number | null;
  activities: ListRule | null;
  manual: ListRule | null;
  courses: ListRule | null;
  cohort: ListRule | null;
}

type Rule = { kind: string; [k: string]: unknown };

function fromCriteria(c: { method?: Method; rules?: Rule[] } | undefined): State {
  const rules = c?.rules ?? [];
  const list = (kind: string, key: string): ListRule | null => {
    const r = rules.find((x) => x.kind === kind);
    return r ? { ids: (r[key] as string[]) ?? [], method: (r.method as Method) ?? 'all' } : null;
  };
  const grade = rules.find((x) => x.kind === 'courseGrade');
  return {
    method: c?.method ?? 'all',
    courseCompletion: rules.some((x) => x.kind === 'courseCompletion'),
    courseGrade: grade ? Number(grade.minPercent) : null,
    activities: list('activities', 'activityIds'),
    manual: list('manual', 'roleIds'),
    courses: list('courses', 'courseIds'),
    cohort: list('cohort', 'cohortIds'),
  };
}

function toCriteria(s: State) {
  const rules: Rule[] = [];
  if (s.courseCompletion) rules.push({ kind: 'courseCompletion' });
  if (s.activities)
    rules.push({ kind: 'activities', activityIds: s.activities.ids, method: s.activities.method });
  if (s.courseGrade !== null) rules.push({ kind: 'courseGrade', minPercent: s.courseGrade });
  if (s.courses)
    rules.push({ kind: 'courses', courseIds: s.courses.ids, method: s.courses.method });
  if (s.manual) rules.push({ kind: 'manual', roleIds: s.manual.ids, method: s.manual.method });
  if (s.cohort) rules.push({ kind: 'cohort', cohortIds: s.cohort.ids, method: s.cohort.method });
  return { method: s.method, rules };
}

/** A rule over a list (activities, roles, courses, cohorts): which ones, and all or any. */
function ListRuleFields({
  label,
  rule,
  options,
  disabled,
  onChange,
}: {
  label: string;
  rule: ListRule | null;
  options: Option[];
  disabled: boolean;
  onChange: (r: ListRule | null) => void;
}) {
  const t = useTranslations('badges');
  const id = useId();
  return (
    <fieldset className="grid gap-2 rounded-md border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-sm">
        <label htmlFor={`${id}-on`} className="flex items-center gap-2">
          <Checkbox
            id={`${id}-on`}
            checked={!!rule}
            onChange={(e) => onChange(e.target.checked ? { ids: [], method: 'all' } : null)}
          />
          {label}
        </label>
      </legend>
      {rule ? (
        <>
          <fieldset
            aria-label={label}
            className="grid max-h-48 gap-1 overflow-y-auto text-sm sm:grid-cols-2"
          >
            {options.map((o) => (
              <label key={o.id} htmlFor={`${id}-${o.id}`} className="flex items-start gap-2">
                <Checkbox
                  id={`${id}-${o.id}`}
                  checked={rule.ids.includes(o.id)}
                  onChange={(e) =>
                    onChange({
                      ...rule,
                      ids: e.target.checked
                        ? [...rule.ids, o.id]
                        : rule.ids.filter((x) => x !== o.id),
                    })
                  }
                  className="mt-0.5"
                />
                <span className="break-words">{o.name}</span>
              </label>
            ))}
            {options.length ? null : (
              <span className="text-muted-foreground">{t('noOptions')}</span>
            )}
          </fieldset>
          <Field label={t('ruleMethod')} htmlFor={`${id}-m`}>
            <Select
              id={`${id}-m`}
              value={rule.method}
              onChange={(e) => onChange({ ...rule, method: e.target.value as Method })}
            >
              <option value="all">{t('methodAll')}</option>
              <option value="any">{t('methodAny')}</option>
            </Select>
          </Field>
        </>
      ) : null}
    </fieldset>
  );
}

/** Why the criteria were refused (they have no field of their own). */
function CriteriaError() {
  const error = useFieldError('criteria');
  return error?.length ? (
    <p role="alert" className="text-sm text-destructive">
      {error.join(' ')}
    </p>
  ) : null;
}

export function BadgeEditor({
  courseId,
  badge,
  options,
  locked,
}: {
  courseId: string | null;
  badge?: {
    id: string;
    name: string;
    description: string;
    criteria: { method?: Method; rules?: Rule[] };
    expiresAfterDays: number | null;
    expiresAt: string | null;
  };
  options: BadgeEditorOptions;
  /** Awarded already: what earns it and for how long stay as they are. */
  locked: boolean;
}) {
  const t = useTranslations('badges');
  const tc = useTranslations('common');
  const router = useRouter();
  const [s, set] = useState<State>(() => fromCriteria(badge?.criteria));
  const [expiry, setExpiry] = useState<'never' | 'days' | 'date'>(
    badge?.expiresAfterDays ? 'days' : badge?.expiresAt ? 'date' : 'never',
  );
  const base = courseId ? `/course/${courseId}/badges` : '/admin/badges';
  return (
    <ActionForm
      action={saveBadgeAction}
      success={tc('saved')}
      onSuccess={(r: { id: string }) => {
        router.push(`${base}/${r.id}`);
        router.refresh();
      }}
      className="grid gap-4"
    >
      {badge ? <input type="hidden" name="id" value={badge.id} /> : null}
      {courseId ? <input type="hidden" name="courseId" value={courseId} /> : null}
      {/* outside the fieldsets: a disabled fieldset leaves its fields out of the form */}
      <input type="hidden" name="criteria" value={JSON.stringify(toCriteria(s))} />
      <input type="hidden" name="expiry" value={expiry} />
      {locked && badge?.expiresAfterDays ? (
        <input type="hidden" name="expiresAfterDays" value={badge.expiresAfterDays} />
      ) : null}
      {locked && badge?.expiresAt ? (
        <input type="hidden" name="expiresAt" value={badge.expiresAt} />
      ) : null}
      <FormField
        name="name"
        label={t('name')}
        defaultValue={badge?.name}
        required
        maxLength={255}
      />
      <FormField name="description" label={t('description')}>
        <Textarea
          id="f-description"
          name="description"
          defaultValue={badge?.description}
          className="min-h-20"
        />
      </FormField>
      <FormField
        name="image"
        label={t('image')}
        hint={t('imageHint')}
        type="file"
        accept="image/png,image/svg+xml,.png,.svg"
      />
      <fieldset className="grid gap-3" disabled={locked}>
        <legend className="mb-1 text-sm font-medium">{t('criteria')}</legend>
        {locked ? <p className="text-sm text-muted-foreground">{t('locked')}</p> : null}
        <CriteriaError />
        <Field label={t('criteriaMethod')} htmlFor="b-method">
          <Select
            id="b-method"
            value={s.method}
            onChange={(e) => set({ ...s, method: e.target.value as Method })}
          >
            <option value="all">{t('criteriaAll')}</option>
            <option value="any">{t('criteriaAny')}</option>
          </Select>
        </Field>
        {courseId ? (
          <>
            <label htmlFor="b-course" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="b-course"
                checked={s.courseCompletion}
                onChange={(e) => set({ ...s, courseCompletion: e.target.checked })}
              />
              {t('rules.courseCompletion')}
            </label>
            <ListRuleFields
              label={t('rules.activities')}
              rule={s.activities}
              options={options.activities}
              disabled={locked}
              onChange={(activities) => set({ ...s, activities })}
            />
            <div className="grid gap-2 rounded-md border border-border p-3">
              <label htmlFor="b-grade-on" className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="b-grade-on"
                  checked={s.courseGrade !== null}
                  onChange={(e) => set({ ...s, courseGrade: e.target.checked ? 50 : null })}
                />
                {t('rules.courseGrade')}
              </label>
              {s.courseGrade !== null ? (
                <Field label={t('minPercent')} htmlFor="b-grade">
                  <Input
                    id="b-grade"
                    type="number"
                    min={0}
                    max={100}
                    value={s.courseGrade}
                    onChange={(e) => set({ ...s, courseGrade: Number(e.target.value) })}
                    className="w-28"
                  />
                </Field>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <ListRuleFields
              label={t('rules.courses')}
              rule={s.courses}
              options={options.courses}
              disabled={locked}
              onChange={(courses) => set({ ...s, courses })}
            />
            <ListRuleFields
              label={t('rules.cohort')}
              rule={s.cohort}
              options={options.cohorts}
              disabled={locked}
              onChange={(cohort) => set({ ...s, cohort })}
            />
          </>
        )}
        <ListRuleFields
          label={t('rules.manual')}
          rule={s.manual}
          options={options.roles}
          disabled={locked}
          onChange={(manual) => set({ ...s, manual })}
        />
      </fieldset>
      <fieldset className="grid gap-2" disabled={locked}>
        <legend className="mb-1 text-sm font-medium">{t('expiry')}</legend>
        {(['never', 'days', 'date'] as const).map((v) => (
          <label key={v} htmlFor={`b-exp-${v}`} className="flex items-center gap-2 text-sm">
            <input
              id={`b-exp-${v}`}
              type="radio"
              name="expiryChoice"
              checked={expiry === v}
              onChange={() => setExpiry(v)}
            />
            {t(`expiryChoice.${v}`)}
          </label>
        ))}
        {expiry === 'days' ? (
          <FormField
            name="expiresAfterDays"
            label={t('expiresAfterDays')}
            type="number"
            min={1}
            defaultValue={badge?.expiresAfterDays ?? 365}
            className="w-40"
          />
        ) : null}
        {expiry === 'date' ? (
          <FormField
            name="expiresAt"
            label={t('expiresAt')}
            type="date"
            defaultValue={badge?.expiresAt?.slice(0, 10)}
            className="w-48"
          />
        ) : null}
      </fieldset>
      <div>
        <SubmitButton>{tc('save')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
