'use client';

import { CalendarDays, X } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useFormReset } from '../lib/use-form-reset.ts';
import { Calendar, type CalendarLocale } from './calendar.tsx';
import { fieldClass } from './input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';

// Values use the same strings as native inputs, so server code is unaffected:
// a date is "YYYY-MM-DD", a local date-time "YYYY-MM-DDTHH:mm".

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateString(s: string | null | undefined): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** "9", "930", "9:5", "21:30" → "09:00", "09:30", "09:05", "21:30"; anything else → null. */
export function normalizeTime(raw: string): string | null {
  const s = raw.trim();
  let h: string;
  let m: string;
  if (s.includes(':')) {
    [h = '', m = ''] = s.split(':');
  } else {
    const digits = s.replace(/\D/g, '');
    [h, m] = digits.length <= 2 ? [digits, ''] : [digits.slice(0, -2), digits.slice(-2)];
  }
  if (!/^\d{1,2}$/.test(h) || !/^\d{0,2}$/.test(m)) return null;
  const hh = Number(h);
  const mm = Number(m || 0);
  if (hh > 23 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

export interface DatePickerLabels {
  /** Shown while no date is chosen. */
  placeholder: string;
  clear: string;
  today: string;
}

const LOCALE_TAGS: Record<CalendarLocale, string> = { ru: 'ru-RU', en: 'en-US' };

/** Hidden field that submits the value; focusing it (validation errors) focuses the picker. */
function ValueField({
  name,
  form,
  value,
  onFocus,
  onReset,
}: {
  name?: string;
  form?: string;
  value: string;
  onFocus: () => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useFormReset(ref, onReset);
  return (
    <input
      ref={ref}
      type="text"
      name={name}
      form={form}
      value={value}
      readOnly
      tabIndex={-1}
      aria-hidden="true"
      autoComplete="off"
      onFocus={onFocus}
      className="pointer-events-none absolute inset-0 -z-10 opacity-0"
    />
  );
}

export interface DatePickerProps {
  id?: string;
  name?: string;
  form?: string;
  /** "YYYY-MM-DD" or "" (controlled). */
  value?: string;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  locale?: CalendarLocale;
  labels: DatePickerLabels;
  /** Hides the clear button. */
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Earliest and latest selectable day, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export function DatePicker({
  id,
  name,
  form,
  value,
  defaultValue,
  onChange,
  locale = 'ru',
  labels,
  required,
  disabled,
  invalid,
  min,
  max,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: DatePickerProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => (parseDateString(defaultValue) ? defaultValue! : ''));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = controlled ? value : inner;
  const date = parseDateString(current);
  const minDate = parseDateString(min);
  const maxDate = parseDateString(max);

  function set(next: string) {
    if (!controlled) setInner(next);
    onChange?.(next);
  }

  const shown = date
    ? new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'long' }).format(date)
    : labels.placeholder;

  return (
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            id={id}
            type="button"
            role="combobox"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-invalid={invalid}
            aria-label={ariaLabel}
            aria-describedby={describedBy}
            disabled={disabled}
            className={cn(
              fieldClass,
              'flex h-9 items-center gap-2 py-1 text-left outline-none focus-visible:border-ring',
              !date && 'text-muted-foreground',
              date && !required && 'pr-9',
            )}
          >
            <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate">{shown}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label={labels.placeholder} className="w-auto p-0">
          <Calendar
            locale={locale}
            selected={date}
            defaultMonth={date ?? minDate}
            disabled={[
              ...(minDate ? [{ before: minDate }] : []),
              ...(maxDate ? [{ after: maxDate }] : []),
            ]}
            onSelect={(d) => {
              if (!d) return;
              set(toDateString(d));
              setOpen(false);
            }}
            autoFocus
          />
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-sm font-medium text-accent hover:bg-muted"
              onClick={() => {
                set(toDateString(new Date()));
                setOpen(false);
              }}
            >
              {labels.today}
            </button>
            {!required && date ? (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => {
                  set('');
                  setOpen(false);
                }}
              >
                {labels.clear}
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
      {date && !required && !disabled ? (
        <button
          type="button"
          aria-label={labels.clear}
          title={labels.clear}
          onClick={() => {
            set('');
            trigger.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <ValueField
        name={name}
        form={form}
        value={current}
        onFocus={() => trigger.current?.focus()}
        onReset={() => setInner(parseDateString(defaultValue) ? defaultValue! : '')}
      />
    </div>
  );
}

export interface DateTimePickerLabels extends DatePickerLabels {
  time: string;
  /** Placeholder of the time field, e.g. "чч:мм". */
  timePlaceholder: string;
}

export interface DateTimePickerProps
  extends Omit<DatePickerProps, 'labels' | 'value' | 'defaultValue' | 'onChange'> {
  labels: DateTimePickerLabels;
  /** Local "YYYY-MM-DDTHH:mm" or "" (controlled). */
  value?: string;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  /** Time used when a day is picked before a time is typed. */
  defaultTime?: string;
}

function splitLocal(v: string | null | undefined): [string, string] {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(v ?? '');
  return m ? [m[1]!, m[2]!] : ['', ''];
}

export function DateTimePicker({
  id,
  name,
  form,
  value,
  defaultValue,
  onChange,
  labels,
  defaultTime = '00:00',
  required,
  disabled,
  invalid,
  className,
  ...rest
}: DateTimePickerProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => splitLocal(defaultValue));
  const [day, time] = controlled ? splitLocal(value) : inner;
  // What is being typed in the time field, before it is normalised on blur.
  const [draft, setDraft] = useState<string | null>(null);
  const draftInvalid = draft !== null && draft.trim() !== '' && normalizeTime(draft) === null;
  const dateField = useRef<HTMLDivElement>(null);

  function set(nextDay: string, nextTime: string) {
    const t = nextDay ? nextTime || defaultTime : nextTime;
    if (!controlled) setInner([nextDay, t]);
    onChange?.(nextDay ? `${nextDay}T${t}` : '');
  }

  const local = day ? `${day}T${time || defaultTime}` : '';

  return (
    <div className={cn('relative flex gap-2', className)}>
      <div ref={dateField} className="min-w-0 flex-1">
        <DatePicker
          id={id}
          value={day}
          onChange={(d) => set(d, time)}
          labels={labels}
          required={required}
          disabled={disabled}
          invalid={invalid}
          {...rest}
        />
      </div>
      <input
        id={id ? `${id}-time` : undefined}
        type="text"
        inputMode="numeric"
        aria-label={labels.time}
        aria-invalid={invalid || draftInvalid}
        placeholder={labels.timePlaceholder}
        disabled={disabled}
        maxLength={5}
        value={draft ?? time}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const raw = e.target.value.replace(/[^\d:]/g, '');
          setDraft(raw);
          // Keep the submitted value current while typing (Enter submits without a blur).
          const t = normalizeTime(raw);
          if (t) set(day, t);
        }}
        onBlur={() => {
          if (draft !== null && !draft.trim()) set(day, '');
          // Show the normalised time ("930" → "09:30"), or the last valid one.
          setDraft(null);
        }}
        className={cn(fieldClass, 'h-9 w-20 shrink-0 py-1 text-center tabular-nums')}
      />
      <ValueField
        name={name}
        form={form}
        value={local}
        onFocus={() => dateField.current?.querySelector('button')?.focus()}
        onReset={() => {
          setDraft(null);
          setInner(splitLocal(defaultValue));
        }}
      />
    </div>
  );
}
