'use client';

import { useLocale, useTranslations } from 'next-intl';
import { FormField, useFieldError } from '@/components/action-form';

export interface LanguageOption {
  code: string;
  name: string;
}

/**
 * One text field per language, named `<name>_<code>`; the first (the site language) is
 * required. The server reads them back with localizedFromForm(values, name).
 */
export function LocalizedFields({
  name,
  label,
  languages,
  values,
  idSuffix = '',
  maxLength,
}: {
  name: string;
  label: string;
  languages: LanguageOption[];
  values?: Record<string, string>;
  idSuffix?: string;
  maxLength?: number;
}) {
  const tc = useTranslations('common');
  const locale = useLocale();
  const error = useFieldError(name);
  // languages are named in the interface language: "Name (German)"
  const named = (code: string, own: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? own;
    } catch {
      return own;
    }
  };
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {languages.map((l, i) => (
        <FormField
          key={l.code}
          id={`f-${name}-${l.code}${idSuffix}`}
          name={`${name}_${l.code}`}
          label={tc('inLanguage', { label, language: named(l.code, l.name) })}
          defaultValue={values?.[l.code] ?? ''}
          required={i === 0}
          maxLength={maxLength}
          lang={l.code}
        />
      ))}
      {error ? <p className="text-sm text-destructive sm:col-span-2">{error.join(' ')}</p> : null}
    </div>
  );
}
