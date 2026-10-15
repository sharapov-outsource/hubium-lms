'use client';

import { Command } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { Highlight, matchScore } from '../lib/search.tsx';
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
  /**
   * For lists too long to hand over whole: called as the search changes, and `options`
   * are then shown as given (the matches the caller found) instead of filtered here.
   */
  onSearch?: (search: string) => void;
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
  onSearch,
}: ComboboxProps) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? '');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // the chosen option keeps its label when a later search brings other options
  const [picked, setPicked] = useState<ComboboxOption | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useFormReset(field, () => setInner(defaultValue ?? ''));
  const current = controlled ? value : inner;
  const selected =
    options.find((o) => o.value === current) ?? (picked?.value === current ? picked : undefined);
  const searchFor = (q: string) => {
    setSearch(q);
    onSearch?.(q);
  };

  return (
    <div className={cn('relative', className)}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          searchFor('');
        }}
      >
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
            shouldFilter={!onSearch}
            // Substring search in the label; the value, hint and keywords count for less.
            filter={(itemValue, q, keywords = []) =>
              matchScore(q, keywords[0] ?? '', `${itemValue} ${keywords.slice(1).join(' ')}`)
            }
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Command.Input
                value={search}
                onValueChange={searchFor}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="scrollbar-hairline max-h-72 overflow-y-auto overscroll-contain p-1">
              <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
                {emptyText}
              </Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={o.value}
                  keywords={[o.label, o.hint ?? '', ...(o.keywords ?? [])]}
                  onSelect={() => {
                    if (!controlled) setInner(o.value);
                    setPicked(o);
                    onChange?.(o.value);
                    setOpen(false);
                  }}
                  className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-8 pr-2 text-sm outline-none data-[selected=true]:bg-muted"
                >
                  {o.value === current ? (
                    <Check className="absolute left-2 size-4 text-accent" aria-hidden />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    <Highlight text={o.label} search={search} />
                  </span>
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
