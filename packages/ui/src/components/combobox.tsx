'use client';

import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useFormReset } from '../lib/use-form-reset.ts';
import { fieldClass } from './input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary text on the right, e.g. a UTC offset. */
  hint?: string;
  /** Extra words that find this option in the search. */
  keywords?: string[];
}

export interface ComboboxProps {
  id?: string;
  name?: string;
  form?: string;
  options: ComboboxOption[];
  value?: string;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  'aria-describedby'?: string;
}

/** A select with a search box, for long lists (time zones, users, courses). */
export function Combobox({
  id,
  name,
  form,
  options,
  value,
  defaultValue,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled,
  invalid,
  className,
  'aria-describedby': describedBy,
}: ComboboxProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useFormReset(field, () => setInner(defaultValue ?? ''));
  const current = controlled ? value : inner;
  const selected = options.find((o) => o.value === current);

  return (
    <div className={cn('relative', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            id={id}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            disabled={disabled}
            className={cn(
              fieldClass,
              'flex h-9 items-center justify-between gap-2 py-1 text-left outline-none focus-visible:border-ring',
              !selected && 'text-muted-foreground',
            )}
          >
            <span className="min-w-0 truncate">{selected?.label ?? current ?? placeholder}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0">
          <Command
            loop
            // Every word must match; hits in the value or label rank above keyword-only hits.
            filter={(itemValue, search, keywords = []) => {
              const norm = (t: string) => t.toLowerCase().replace(/[\s_/]+/g, ' ');
              const words = norm(search).trim().split(' ');
              const main = norm(`${itemValue} ${keywords[0] ?? ''}`);
              const all = `${main} ${norm(keywords.slice(1).join(' '))}`;
              if (!words.every((w) => all.includes(w))) return 0;
              return words.every((w) => main.includes(w)) ? 1 : 0.5;
            }}
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Command.Input
                placeholder={searchPlaceholder}
                className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-72 overflow-y-auto overscroll-contain p-1">
              <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
                {emptyText}
              </Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, ...(o.keywords ?? [])]}
                  onSelect={() => {
                    if (!controlled) setInner(o.value);
                    onChange?.(o.value);
                    setOpen(false);
                  }}
                  className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-sm outline-none data-[selected=true]:bg-muted"
                >
                  {o.value === current ? (
                    <Check className="absolute left-2 size-4 text-accent" aria-hidden />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {o.hint}
                    </span>
                  ) : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>
      <input
        ref={field}
        type="text"
        name={name}
        form={form}
        value={current}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        onFocus={() => trigger.current?.focus()}
        className="pointer-events-none absolute inset-0 -z-10 opacity-0"
      />
    </div>
  );
}
