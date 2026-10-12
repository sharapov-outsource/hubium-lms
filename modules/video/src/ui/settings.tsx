'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { VideoSettingsT } from '../server.ts';

function Bool({
  name,
  label,
  checked,
}: {
  name: keyof VideoSettingsT;
  label: string;
  checked: boolean;
}) {
  return (
    <label htmlFor={`vs-${name}`} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="settings.__bool" value={name} />
      <Checkbox id={`vs-${name}`} name={`settings.${name}`} defaultChecked={checked} />
      {label}
    </label>
  );
}

export function VideoSettingsFields({ settings }: SettingsFieldsProps<VideoSettingsT>) {
  const t = useTranslations('mod.video');
  const [source, setSource] = useState(settings.source);
  const urlError = useFieldErrors('settings.embedUrl');
  return (
    <div className="grid gap-4">
      <Field label={t('source')} htmlFor="vs-source">
        <Select
          id="vs-source"
          name="settings.source"
          value={source}
          onChange={(e) => setSource(e.target.value as VideoSettingsT['source'])}
        >
          <option value="upload">{t('sources.upload')}</option>
          <option value="embed">{t('sources.embed')}</option>
        </Select>
      </Field>
      {source === 'embed' ? (
        <Field label={t('embedUrl')} htmlFor="vs-embedUrl" hint={t('embedHint')} error={urlError}>
          <Input
            id="vs-embedUrl"
            name="settings.embedUrl"
            type="url"
            defaultValue={settings.embedUrl}
            placeholder="https://youtu.be/…"
            aria-invalid={!!urlError}
          />
        </Field>
      ) : (
        <>
          <input type="hidden" name="settings.embedUrl" value="" />
          <p className="text-sm text-muted-foreground">{t('uploadAfterSave')}</p>
          <Bool name="deleteSource" label={t('deleteSource')} checked={settings.deleteSource} />
        </>
      )}
      <Bool name="noSeekAhead" label={t('noSeekAhead')} checked={settings.noSeekAhead} />
    </div>
  );
}

export function VideoCompletionFields({ rules }: { rules: Record<string, unknown> }) {
  const t = useTranslations('mod.video');
  return (
    <Field label={t('minPercent')} htmlFor="vc-minPercent" hint={t('minPercentHint')}>
      <Input
        id="vc-minPercent"
        name="completion.minPercent"
        type="number"
        min={0}
        max={100}
        defaultValue={Number(rules.minPercent ?? 90)}
        className="w-28"
      />
    </Field>
  );
}
