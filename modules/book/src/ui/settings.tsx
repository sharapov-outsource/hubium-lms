'use client';

import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { BookSettingsT } from '../server.ts';

export function BookSettingsFields({ settings }: SettingsFieldsProps<BookSettingsT>) {
  const t = useTranslations('mod.book');
  return (
    <>
      <Field label={t('numbering')} htmlFor="bk-numbering">
        <Select id="bk-numbering" name="settings.numbering" defaultValue={settings.numbering}>
          {(['numbers', 'bullets', 'indented', 'none'] as const).map((n) => (
            <option key={n} value={n}>
              {t(`numberingOptions.${n}`)}
            </option>
          ))}
        </Select>
      </Field>
      <label htmlFor="bk-customTitles" className="flex items-center gap-2 text-sm">
        <Checkbox
          id="bk-customTitles"
          name="settings.customTitles"
          defaultChecked={settings.customTitles}
        />
        {t('customTitles')}
      </label>
    </>
  );
}
