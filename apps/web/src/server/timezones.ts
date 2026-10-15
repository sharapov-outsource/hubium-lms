import type { ComboboxOption } from '@hubium/ui';

/** Every IANA zone with its current UTC offset; the localized zone name finds it in search. */
export function timezoneOptions(locale: string): ComboboxOption[] {
  const now = new Date();
  const part = (timeZone: string, timeZoneName: 'shortOffset' | 'long') =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return Intl.supportedValuesOf('timeZone').map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
    hint: part(zone, 'shortOffset').replace('GMT', 'UTC'),
    keywords: [part(zone, 'long')],
  }));
}
