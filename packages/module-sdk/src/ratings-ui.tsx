'use client';

import { Field, Input, Select } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DateTimeInput, useFieldErrors } from './form.tsx';
import { type RatingAggregate, ratingAggregates } from './ratings.ts';

/**
 * An item's rating: the aggregate as the user may see it, who rated what, and a select for
 * those who rate (points 0..max, or the scale). `messages` names the module's message
 * group with the keys `aggregates.<kind>`, `count`, `yours`, `rateLabel`, `raters`.
 */
export function RatingControl({
  id,
  messages,
  authorName,
  kind,
  scale,
  max,
  rating,
  pending,
  onRate,
}: {
  id: string;
  messages: string;
  authorName: string;
  kind: Exclude<RatingAggregate, 'none'>;
  scale: string[] | null;
  max: number;
  rating: {
    aggregate: number | null;
    count: number;
    mine: number | null;
    canRate: boolean;
    raters: { name: string; value: number }[];
  };
  pending?: boolean;
  onRate(value: number | null): void;
}) {
  const t = useTranslations(messages);
  const label = (v: number) => (scale ? (scale[v - 1] ?? String(v)) : String(v));
  // a count is a number of ratings, not a rating
  const shown = (v: number) => (scale && kind !== 'count' ? label(Math.round(v)) : String(v));
  const values = scale ? scale.map((_, i) => i + 1) : Array.from({ length: max + 1 }, (_, i) => i);
  if (rating.aggregate === null && !rating.canRate) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      {rating.aggregate !== null ? (
        <span>
          {t(`aggregates.${kind}`, { value: shown(rating.aggregate) })}{' '}
          <span className="text-muted-foreground">({t('count', { n: rating.count })})</span>
        </span>
      ) : null}
      {rating.canRate ? (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="text-muted-foreground">
            {t('yours')}
          </span>
          <Select
            id={`rate-${id}`}
            aria-label={t('rateLabel', { name: authorName })}
            className="w-40"
            value={rating.mine === null ? '' : String(rating.mine)}
            disabled={pending}
            onChange={(e) => onRate(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">—</option>
            {values.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </Select>
        </span>
      ) : null}
      {rating.raters.length ? (
        <details className="w-full">
          <summary className="cursor-pointer text-muted-foreground">{t('raters')}</summary>
          <ul className="mt-1 grid gap-0.5 pl-4">
            {rating.raters.map((r) => (
              <li key={r.name}>
                {r.name}: {label(r.value)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

type RatingSettings = {
  ratingAggregate: RatingAggregate;
  ratingScaleId: string | null;
  ratingMax: number;
  ratingPass?: number;
  ratingFrom: string | null;
  ratingTo: string | null;
};

/**
 * The settings of `ratingFields` in an activity form: how ratings make a grade, points or a
 * scale, and which items may be rated. `messages` names the module's message group with the
 * keys `title`, `aggregate`, `aggregates.<kind>`, `type`, `points`, `max`, `pass`, `from`,
 * `to` and `hint`; `children` go before the hint (e.g. who else may rate).
 */
export function RatingSettingsFields({
  idPrefix,
  messages,
  settings,
  scales,
  children,
}: {
  idPrefix: string;
  messages: string;
  settings: RatingSettings;
  scales: { id: string; name: string }[];
  children?: ReactNode;
}) {
  const t = useTranslations(messages);
  const id = (name: keyof RatingSettings) => `${idPrefix}-${name}`;
  return (
    <fieldset className="grid gap-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium">{t('title')}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('aggregate')} htmlFor={id('ratingAggregate')}>
          <Select
            id={id('ratingAggregate')}
            name="settings.ratingAggregate"
            defaultValue={settings.ratingAggregate}
          >
            {ratingAggregates.map((k) => (
              <option key={k} value={k}>
                {t(`aggregates.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('type')} htmlFor={id('ratingScaleId')}>
          <Select
            id={id('ratingScaleId')}
            name="settings.ratingScaleId"
            defaultValue={settings.ratingScaleId ?? ''}
          >
            <option value="">{t('points')}</option>
            {scales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <RatingNumber
          id={id('ratingMax')}
          name="ratingMax"
          label={t('max')}
          value={settings.ratingMax}
          min={1}
        />
        <RatingNumber
          id={id('ratingPass')}
          name="ratingPass"
          label={t('pass')}
          value={settings.ratingPass}
        />
        <RatingDate
          id={id('ratingFrom')}
          name="ratingFrom"
          label={t('from')}
          value={settings.ratingFrom}
        />
        <RatingDate id={id('ratingTo')} name="ratingTo" label={t('to')} value={settings.ratingTo} />
      </div>
      {children}
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
    </fieldset>
  );
}

function RatingNumber({
  id,
  name,
  label,
  value,
  min = 0,
}: {
  id: string;
  name: 'ratingMax' | 'ratingPass';
  label: string;
  value: number | undefined;
  min?: number;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={id} error={error}>
      <Input
        id={id}
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

function RatingDate({
  id,
  name,
  label,
  value,
}: {
  id: string;
  name: 'ratingFrom' | 'ratingTo';
  label: string;
  value: string | null;
}) {
  const error = useFieldErrors(`settings.${name}`);
  return (
    <Field label={label} htmlFor={id} error={error}>
      <DateTimeInput
        id={id}
        name={`settings.${name}`}
        defaultValue={value}
        defaultTime={name === 'ratingFrom' ? '00:00' : '23:59'}
        ariaInvalid={!!error}
      />
    </Field>
  );
}
