'use client';

import { Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';

const FRACTIONS: [string, string][] = [
  ['1', 'p100'],
  ['0.5', 'p50'],
  ['0.3333333', 'p33'],
  ['0.25', 'p25'],
  ['0.2', 'p20'],
  ['0', 'p0'],
  ['-0.5', 'm50'],
  ['-1', 'm100'],
];
export function FractionSelect({
  value,
  onChange,
  label,
  allowNegative,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  allowNegative?: boolean;
}) {
  const t = useTranslations('qbank');
  return (
    <Select
      aria-label={label}
      className="w-24"
      value={FRACTIONS.find(([f]) => Math.abs(Number(f) - value) < 1e-6)?.[0] ?? String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {FRACTIONS.filter(([f]) => allowNegative || Number(f) >= 0).map(([f, key]) => (
        <option key={f} value={f}>
          {t(`fractions.${key}` as 'fractions.p100')}
        </option>
      ))}
    </Select>
  );
}
