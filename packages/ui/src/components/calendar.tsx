'use client';

import { DayPicker, type DropdownProps, type PropsBase, type PropsSingle } from '@daypicker/react';
import { enUS, ru } from '@daypicker/react/locale';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn.ts';
import { Select } from './select.tsx';

export type CalendarLocale = 'ru' | 'en';

const LOCALES = { ru, en: enUS } as const;

/** Month and year pickers in the caption use our listbox instead of native selects. */
function CaptionDropdown({ options, value, onChange, 'aria-label': ariaLabel }: DropdownProps) {
  return (
    <Select
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
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
  locale = 'ru',
  className,
  classNames,
  ...props
}: Omit<PropsBase, 'locale' | 'mode' | 'required'> &
  Pick<PropsSingle, 'selected' | 'onSelect'> & { locale?: CalendarLocale }) {
  const year = new Date().getFullYear();
  return (
    <DayPicker
      mode="single"
      locale={LOCALES[locale]}
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
