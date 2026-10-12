'use client';

import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';

export function FileSettings({ settings, files }: SettingsFieldsProps<{ display: string }>) {
  const t = useTranslations('mod.file');
  const existing = files?.content ?? [];
  return (
    <div className="grid gap-4">
      {existing.length ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm font-medium">{t('files')}</legend>
          {existing.map((f) => (
            <label key={f.id} htmlFor={`rm-${f.id}`} className="flex items-center gap-2 text-sm">
              <Checkbox id={`rm-${f.id}`} name="files.remove" value={f.id} />
              <span>
                {t('remove')}:{' '}
                <a href={f.url} className="text-accent hover:underline">
                  {f.name}
                </a>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <Field label={t('addFiles')} htmlFor="f-files-content">
        <Input id="f-files-content" name="files.content" type="file" multiple />
      </Field>
      <Field label={t('display')} htmlFor="f-settings-display">
        <Select id="f-settings-display" name="settings.display" defaultValue={settings.display}>
          <option value="list">{t('displayList')}</option>
          <option value="download">{t('displayDownload')}</option>
        </Select>
      </Field>
    </div>
  );
}
