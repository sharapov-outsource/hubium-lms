'use client';

import type { ActionResult } from '@hubium/core/operation';
import { EditorField } from '@hubium/editor/field';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Select,
} from '@hubium/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';

type Cond =
  | { type: 'date'; op: '>=' | '<'; at: string }
  | { type: 'completion'; activityId: string; state: 'complete' | 'incomplete' | 'pass' | 'fail' }
  | { type: 'group'; groupId?: string }
  | { type: 'grade'; activityId: string; min?: number; max?: number }
  | {
      type: 'profile';
      field: 'email' | 'firstName' | 'lastName' | 'username';
      op: string;
      value: string;
    };

export interface ActivityFormValues {
  id?: string;
  name?: string;
  intro?: string;
  showIntro?: boolean;
  visibility?: string;
  completionMode?: string;
  completionView?: boolean;
  completionExpectedAt?: string;
  groupMode?: string;
  availability?: { op: '&' | '|'; hidden?: boolean; c: Cond[] } | null;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AvailabilityEditor({
  initial,
  activities,
  groups,
}: {
  initial: ActivityFormValues['availability'];
  activities: { id: string; name: string }[];
  groups: { id: string; name: string }[];
}) {
  const t = useTranslations('activity');
  const error = useFieldError('availability');
  const [conds, setConds] = useState<Cond[]>(initial?.c ?? []);
  const [hidden, setHidden] = useState(!!initial?.hidden);
  const json = conds.length
    ? JSON.stringify({
        op: '&',
        hidden,
        c: conds.map((c) => (c.type === 'date' ? { ...c, at: new Date(c.at).toISOString() } : c)),
      })
    : '';
  const update = (i: number, patch: Partial<Cond>) =>
    setConds((cs) => cs.map((c, j) => (j === i ? ({ ...c, ...patch } as Cond) : c)));
  const add = (type: Cond['type']) => {
    const first = activities[0]?.id ?? '';
    const next: Cond =
      type === 'date'
        ? { type, op: '>=', at: new Date(Date.now() + 86_400_000).toISOString() }
        : type === 'completion'
          ? { type, activityId: first, state: 'complete' }
          : type === 'group'
            ? { type }
            : type === 'grade'
              ? { type, activityId: first, min: 50 }
              : { type, field: 'email', op: 'endsWith', value: '' };
    setConds((cs) => [...cs, next]);
  };
  return (
    <div className="grid gap-3">
      <input type="hidden" name="availability" value={json} />
      <p className="text-sm text-muted-foreground">{t('accessHint')}</p>
      {conds.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
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
              <Input
                type="datetime-local"
                aria-label={t('conditionTypes.date')}
                className="w-56"
                value={toLocalInput(c.at)}
                onChange={(e) => update(i, { at: new Date(e.target.value).toISOString() })}
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
          {c.type === 'profile' ? (
            <>
              <Select
                aria-label={t('conditionTypes.profile')}
                className="w-36"
                value={c.field}
                onChange={(e) => update(i, { field: e.target.value as 'email' })}
              >
                {(['email', 'firstName', 'lastName', 'username'] as const).map((f) => (
                  <option key={f} value={f}>
                    {t(`profileFields.${f}`)}
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
                  ['equals', 'contains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty'] as const
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
            onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}
          >
            <X />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {(['date', 'completion', 'group', 'grade', 'profile'] as const)
          .filter((type) =>
            type === 'completion' || type === 'grade' ? activities.length > 0 : true,
          )
          .map((type) => (
            <Button key={type} type="button" variant="outline" size="sm" onClick={() => add(type)}>
              <Plus />
              {t(`conditionTypes.${type}`)}
            </Button>
          ))}
      </div>
      {conds.length ? (
        <label htmlFor="av-hidden" className="flex items-center gap-2 text-sm">
          <Checkbox id="av-hidden" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          {t('hideIfNot')}
        </label>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error.join(', ')}</p> : null}
    </div>
  );
}

export function ActivityForm({
  action,
  hidden,
  values = {},
  courseId,
  settingsFields,
  completionFields,
  supportsView,
  supportsGroups,
  activities,
  groups,
  submitLabel,
}: {
  action: (fd: FormData) => Promise<ActionResult<unknown>>;
  hidden: Record<string, string>;
  values?: ActivityFormValues;
  courseId: string;
  settingsFields: ReactNode;
  completionFields?: ReactNode;
  supportsView: boolean;
  supportsGroups: boolean;
  activities: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  submitLabel: string;
}) {
  const t = useTranslations('activity');
  const tc = useTranslations('course');
  const [mode, setMode] = useState(values.completionMode ?? 'NONE');
  const introError = useFieldError('intro');
  return (
    <ActionForm action={action} success={t('saved')} className="grid max-w-3xl gap-6">
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Card>
        <CardHeader>
          <CardTitle>{t('general')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormField name="name" label={t('name')} defaultValue={values.name} required />
          <EditorField
            name="intro"
            label={t('intro')}
            defaultValue={values.intro}
            courseId={courseId}
            error={introError}
            minHeight={100}
          />
          <label htmlFor="showIntro" className="flex items-center gap-2 text-sm">
            <Checkbox id="showIntro" name="showIntro" defaultChecked={values.showIntro} />
            {t('showIntro')}
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('moduleSettings')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">{settingsFields}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('visibility')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormField name="visibility" label={t('visibility')}>
            <Select id="f-visibility" name="visibility" defaultValue={values.visibility ?? 'SHOWN'}>
              {(['SHOWN', 'HIDDEN', 'STEALTH'] as const).map((v) => (
                <option key={v} value={v}>
                  {t(`visibilities.${v}`)}
                </option>
              ))}
            </Select>
          </FormField>
          {supportsGroups ? (
            <FormField name="groupMode" label={t('groupMode')}>
              <Select id="f-groupMode" name="groupMode" defaultValue={values.groupMode ?? 'NONE'}>
                {(['NONE', 'SEPARATE', 'VISIBLE'] as const).map((g) => (
                  <option key={g} value={g}>
                    {tc(`groupModes.${g}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('completion')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="f-completionMode">{t('completion')}</Label>
            <Select
              id="f-completionMode"
              name="completionMode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              {(['NONE', 'MANUAL', 'AUTO'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`completionModes.${m}`)}
                </option>
              ))}
            </Select>
            {useFieldError('completionRules')?.map((e) => (
              <p key={e} className="text-xs text-destructive">
                {e}
              </p>
            ))}
          </div>
          {mode === 'AUTO' ? (
            <div className="grid gap-3 rounded-lg border border-border p-3">
              {supportsView ? (
                <label htmlFor="completionView" className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id="completionView"
                    name="completionView"
                    defaultChecked={values.completionView}
                  />
                  {t('completionView')}
                </label>
              ) : null}
              {completionFields}
            </div>
          ) : null}
          {mode !== 'NONE' ? (
            <FormField
              name="completionExpectedAt"
              type="date"
              label={t('completionExpected')}
              defaultValue={values.completionExpectedAt}
            />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('access')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AvailabilityEditor
            initial={values.availability}
            activities={activities}
            groups={groups}
          />
        </CardContent>
      </Card>
      <div>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
