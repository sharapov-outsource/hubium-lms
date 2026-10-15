'use client';

import type { ActionResult } from '@hubium/core/operation';
import { EditorField } from '@hubium/editor/field';
import { DateInput } from '@hubium/module-sdk/form';
import { Card, CardContent, CardHeader, CardTitle, Checkbox, Label, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { ActionForm, FormField, SubmitButton, useFieldError } from '@/components/action-form';
import { AvailabilityEditor, type AvailabilityValue } from '@/components/availability-editor';

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
  groupingId?: string | null;
  availability?: AvailabilityValue | null;
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
  groupings = [],
  forcedGroupMode = null,
  profileFields = [],
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
  groupings?: { id: string; name: string }[];
  /** The course's group mode when it is forced on every activity. */
  forcedGroupMode?: string | null;
  profileFields?: { key: string; label: string }[];
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
            <FormField
              name="groupMode"
              label={t('groupMode')}
              hint={forcedGroupMode ? t('groupModeForced') : undefined}
            >
              <Select
                id="f-groupMode"
                name="groupMode"
                defaultValue={forcedGroupMode ?? values.groupMode ?? 'NONE'}
                disabled={!!forcedGroupMode}
              >
                {(['NONE', 'SEPARATE', 'VISIBLE'] as const).map((g) => (
                  <option key={g} value={g}>
                    {tc(`groupModes.${g}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}
          {supportsGroups && groupings.length ? (
            <FormField name="groupingId" label={t('grouping')}>
              <Select id="f-groupingId" name="groupingId" defaultValue={values.groupingId ?? ''}>
                <option value="">{t('noGrouping')}</option>
                {groupings.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
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
          <div className="grid content-start gap-1.5">
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
            <FormField name="completionExpectedAt" label={t('completionExpected')}>
              <DateInput
                id="f-completionExpectedAt"
                name="completionExpectedAt"
                defaultValue={values.completionExpectedAt}
              />
            </FormField>
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
            groupings={groupings}
            profileFields={profileFields}
          />
        </CardContent>
      </Card>
      <div>
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
