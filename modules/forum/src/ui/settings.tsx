'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import { RatingSettingsFields } from '@hubium/module-sdk/ratings-ui';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { ForumSettingsT } from '../server.ts';

function Num({
  name,
  label,
  value,
  min = 0,
}: {
  name: keyof ForumSettingsT;
  label: string;
  value: number | undefined;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={`fs-${name}`} error={error}>
      <Input
        id={`fs-${name}`}
        name={`settings.${name}`}
        type="number"
        min={min}
        step="any"
        defaultValue={value ?? ''}
        aria-invalid={!!error}
      />
    </Field>
  );
}

function Bool({
  name,
  label,
  checked,
}: {
  name: keyof ForumSettingsT;
  label: string;
  checked: boolean;
}) {
  return (
    <label htmlFor={`fs-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`fs-${name}`} name={`settings.${name}`} defaultChecked={checked} />
      {label}
    </label>
  );
}

/** Points or one of the scales, for the whole-forum grade. */
function ScaleSelect({
  name,
  label,
  value,
  scales,
}: {
  name: 'gradeScaleId';
  label: string;
  value: string | null;
  scales: { id: string; name: string }[];
}) {
  const t = useTranslations('mod.forum');
  return (
    <Field label={label} htmlFor={`fs-${name}`}>
      <Select id={`fs-${name}`} name={`settings.${name}`} defaultValue={value ?? ''}>
        <option value="">{t('ratings.points')}</option>
        {scales.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ForumSettingsFields({ settings, scales }: SettingsFieldsProps<ForumSettingsT>) {
  const t = useTranslations('mod.forum');
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('type')} htmlFor="fs-type" hint={t('typeHint')}>
          <Select id="fs-type" name="settings.type" defaultValue={settings.type}>
            <option value="general">{t('types.general')}</option>
            <option value="qanda">{t('types.qanda')}</option>
          </Select>
        </Field>
        <Field label={t('subscription')} htmlFor="fs-subscription">
          <Select
            id="fs-subscription"
            name="settings.subscription"
            defaultValue={settings.subscription}
          >
            <option value="optional">{t('subscriptions.optional')}</option>
            <option value="auto">{t('subscriptions.auto')}</option>
            <option value="forced">{t('subscriptions.forced')}</option>
            <option value="disabled">{t('subscriptions.disabled')}</option>
          </Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Num name="maxAttachments" label={t('maxAttachments')} value={settings.maxAttachments} />
        <Num name="maxFileMB" label={t('maxFileMB')} value={settings.maxFileMB} min={1} />
        <Num name="editMinutes" label={t('editMinutes')} value={settings.editMinutes} />
      </div>
      <Bool
        name="allowPrivateReplies"
        label={t('allowPrivateReplies')}
        checked={settings.allowPrivateReplies}
      />
      <RatingSettingsFields
        idPrefix="fs"
        messages="mod.forum.ratings"
        settings={settings}
        scales={scales ?? []}
      >
        <Bool name="allowPeerRating" label={t('ratings.peer')} checked={settings.allowPeerRating} />
      </RatingSettingsFields>
      <fieldset className="grid gap-3 rounded-lg border border-border p-4">
        <legend className="px-1 text-sm font-medium">{t('whole.title')}</legend>
        <Bool
          name="wholeForumGrading"
          label={t('whole.enable')}
          checked={settings.wholeForumGrading}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <ScaleSelect
            name="gradeScaleId"
            label={t('ratings.type')}
            value={settings.gradeScaleId}
            scales={scales ?? []}
          />
          <Num name="gradeMax" label={t('whole.max')} value={settings.gradeMax} min={1} />
          <Num name="gradePass" label={t('whole.pass')} value={settings.gradePass} />
        </div>
        <p className="text-xs text-muted-foreground">{t('whole.hint')}</p>
      </fieldset>
    </div>
  );
}

export function ForumCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.forum');
  const item = (key: 'posts' | 'discussions' | 'replies') => (
    <Field label={t(`completion.${key}`)} htmlFor={`fc-${key}`}>
      <Input
        id={`fc-${key}`}
        name={`completion.${key}`}
        type="number"
        min={0}
        max={100}
        defaultValue={Number(rules[key] ?? 0)}
        className="w-28"
      />
    </Field>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {item('posts')}
      {item('discussions')}
      {item('replies')}
    </div>
  );
}
