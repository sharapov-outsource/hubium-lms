'use client';

import { DayPicker, type DropdownProps, type PropsBase, type PropsSingle } from '@daypicker/react';
import { enUS } from '@daypicker/react/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { cn } from '../lib/cn.ts';
import { Select } from './select.tsx';

/** A BCP-47 language tag or code; any language Intl knows works without extra data. */
export type CalendarLocale = string;

/** Texts of the navigation that Intl cannot supply (screen-reader labels). */
export interface CalendarLabels {
  previousMonth: string;
  nextMonth: string;
  month: string;
  year: string;
}

const EN_LABELS: CalendarLabels = {
  previousMonth: 'Previous month',
  nextMonth: 'Next month',
  month: 'Month',
  year: 'Year',
};

/** Monday-first unless the language's region starts the week on another day. */
function firstDayOfWeek(locale: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = l.getWeekInfo?.().firstDay ?? l.weekInfo?.firstDay;
    if (first) return (first % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  } catch {}
  return 1;
}

const capitalise = (s: string, locale: string) =>
  s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

/** Day names, months and labels from Intl in `locale` (DayPicker's own data is English). */
function useIntlCalendar(locale: string, text: CalendarLabels) {
  return useMemo(() => {
    const fmt = (o: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale, o);
      } catch {
        return new Intl.DateTimeFormat('en', o);
      }
    };
    const caption = fmt({ month: 'long', year: 'numeric' });
    const month = fmt({ month: 'long' });
    const weekdayShort = fmt({ weekday: 'short' });
    const weekdayLong = fmt({ weekday: 'long' });
    const full = fmt({ dateStyle: 'full' });
    return {
      weekStartsOn: firstDayOfWeek(locale),
      formatters: {
        formatCaption: (d: Date) => capitalise(caption.format(d), locale),
        formatMonthDropdown: (d: Date) => capitalise(month.format(d), locale),
        formatYearDropdown: (d: Date) => String(d.getFullYear()),
        formatWeekdayName: (d: Date) => weekdayShort.format(d),
        formatDay: (d: Date) => String(d.getDate()),
      },
      labels: {
        labelDayButton: (d: Date) => full.format(d),
        labelGrid: (d: Date) => capitalise(caption.format(d), locale),
        labelWeekday: (d: Date) => weekdayLong.format(d),
        labelNext: () => text.nextMonth,
        labelPrevious: () => text.previousMonth,
        labelMonthDropdown: () => text.month,
        labelYearDropdown: () => text.year,
      },
    };
  }, [locale, text]);
}

/** Month and year pickers in the caption use our listbox instead of native selects. */
function CaptionDropdown({ options, value, onChange, 'aria-label': ariaLabel }: DropdownProps) {
  return (
    <Select
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
      // Months and years are in order; typing a year jumps to it without a search box.
      searchable={false}
      className="h-8 w-auto gap-1 border-transparent bg-transparent px-2 font-medium hover:bg-muted"
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

export function Calendar({
  locale = 'en',
  labels = EN_LABELS,
  className,
  classNames,
  ...props
}: Omit<PropsBase, 'locale' | 'mode' | 'required' | 'labels'> &
  Pick<PropsSingle, 'selected' | 'onSelect'> & {
    locale?: CalendarLocale;
    labels?: CalendarLabels;
  }) {
  const year = new Date().getFullYear();
  const intl = useIntlCalendar(locale, labels);
  return (
    <DayPicker
      mode="single"
      locale={enUS}
      weekStartsOn={intl.weekStartsOn}
      formatters={intl.formatters}
      labels={intl.labels}
      showOutsideDays
      captionLayout="dropdown"
      startMonth={new Date(year - 80, 0)}
      endMonth={new Date(year + 10, 11)}
      className={cn('p-3', className)}
      classNames={{
        months: 'relative flex flex-col gap-4',
        month: 'flex flex-col gap-3',
        month_caption: 'flex h-8 items-center pr-16',
        caption_label: 'px-2 text-sm font-medium',
        dropdowns: 'flex items-center gap-0.5',
        nav: 'absolute right-0 top-0 z-10 flex items-center gap-1',
        button_previous:
          'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        button_next:
          'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 pb-1 text-xs font-normal text-muted-foreground',
        week: 'mt-1 flex w-full',
        day: 'size-9 p-0 text-center text-sm',
        day_button:
          'inline-flex size-9 items-center justify-center rounded-md font-normal tabular-nums hover:bg-muted',
        today: '[&>button]:font-semibold [&>button]:text-accent',
        selected:
          '[&>button]:bg-accent [&>button]:font-medium [&>button]:text-accent-foreground [&>button]:hover:bg-accent',
        outside: '[&>button]:text-muted-foreground',
        disabled: '[&>button]:pointer-events-none [&>button]:opacity-40',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          ),
        Dropdown: CaptionDropdown,
      }}
      {...props}
    />
  );
}
