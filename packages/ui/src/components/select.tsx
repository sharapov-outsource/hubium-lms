'use client';

import { Command } from 'cmdk';
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Select as S } from 'radix-ui';
import {
  type ChangeEvent,
  Children,
  type ComponentProps,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.ts';
import { Highlight, matchScore } from '../lib/search.tsx';
import { useFormReset } from '../lib/use-form-reset.ts';
import { fieldClass } from './input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx';
import { useUiText } from './ui-text.tsx';

// Radix reserves the empty string for "no value", but "" is a real choice in our forms
// ("not set", "any"), so it travels through Radix under this stand-in.
const EMPTY = '\u0000empty';
const toRadix = (v: string) => (v === '' ? EMPTY : v);
const fromRadix = (v: string) => (v === EMPTY ? '' : v);

interface Option {
  value: string;
  label: ReactNode;
  text: string;
  disabled: boolean;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Reads <option> children the way a native <select> would (fragments and arrays included). */
function collectOptions(children: ReactNode, out: Option[] = []): Option[] {
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    if (child.type === Fragment) {
      collectOptions(child.props.children, out);
      return;
    }
    if (child.type !== 'option') return;
    const p = child.props as ComponentProps<'option'>;
    const text = textOf(p.children);
    out.push({
      value: p.value === undefined ? text : String(p.value),
      label: p.children,
      text,
      disabled: !!p.disabled,
    });
  });
  return out;
}

/** Lists longer than this get a search box. */
const SEARCH_FROM = 11;

export type SelectProps = Omit<ComponentProps<'select'>, 'onChange'> & {
  /** Receives an event whose target carries `value` and `name`, like a native select. */
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: string;
  /** Search box above the options; by default only for long lists. */
  searchable?: boolean;
};

const triggerClass = cn(
  fieldClass,
  'flex h-9 items-center justify-between gap-2 py-1 text-left outline-none',
  'focus-visible:border-ring data-[placeholder]:text-muted-foreground',
);
const itemClass = cn(
  'relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-8 pr-3 text-sm outline-none',
  'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
);

/**
 * Drop-in replacement for a native <select>: same <option> children and value/defaultValue/
 * onChange props, rendered as a styled listbox. The value is submitted through a hidden field.
 */
export function Select({
  id,
  name,
  value,
  defaultValue,
  onChange,
  disabled,
  form,
  className,
  children,
  placeholder,
  searchable,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: SelectProps) {
  const options = collectOptions(children);
  const controlled = value !== undefined;
  const [inner, setInner] = useState(() =>
    defaultValue === undefined ? '' : String(defaultValue),
  );
  const field = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useFormReset(field, () => setInner(defaultValue === undefined ? '' : String(defaultValue)));

  // Like a native select, an unknown or missing value falls back to the first option.
  const wanted = controlled ? String(value) : inner;
  const current = options.some((o) => o.value === wanted) ? wanted : (options[0]?.value ?? '');
  const selected = options.find((o) => o.value === current);

  function change(next: string) {
    if (!controlled) setInner(next);
    // Update the DOM value first so handlers that read the form see the new value.
    if (field.current) field.current.value = next;
    const target = (field.current ?? { value: next, name }) as unknown as HTMLSelectElement;
    onChange?.({ target, currentTarget: target, type: 'change' } as ChangeEvent<HTMLSelectElement>);
  }

  const aria = {
    'aria-invalid': ariaInvalid,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
  };
  // Carries the value into FormData; focusing it (e.g. on a validation error) moves focus to
  // the visible trigger.
  const valueField = (
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
      className="sr-only"
    />
  );

  if (searchable ?? options.length >= SEARCH_FROM) {
    return (
      // `contents`: the trigger itself is the grid/flex item, as a native <select> would be.
      <div className="contents">
        <SearchList
          triggerRef={trigger}
          id={id}
          className={className}
          disabled={disabled}
          options={options}
          current={current}
          selected={selected}
          placeholder={placeholder}
          aria={aria}
          onPick={change}
        />
        {valueField}
      </div>
    );
  }

  return (
    // `contents`: the trigger itself is the grid/flex item, as a native <select> would be.
    <div className="contents">
      <S.Root
        value={toRadix(current)}
        onValueChange={(v) => change(fromRadix(v))}
        disabled={disabled}
      >
        <S.Trigger
          ref={trigger}
          id={id}
          data-value={current}
          {...aria}
          className={cn(triggerClass, className)}
        >
          <span className="min-w-0 truncate">
            <S.Value placeholder={placeholder}>{selected?.label}</S.Value>
          </span>
          <S.Icon asChild>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </S.Icon>
        </S.Trigger>
        <S.Portal>
          <S.Content
            position="popper"
            sideOffset={4}
            collisionPadding={8}
            className={cn(
              'relative z-50 max-h-[min(var(--radix-select-content-available-height),20rem)] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-1rem)] overflow-hidden',
              'rounded-lg border border-border bg-card text-card-foreground shadow-lg data-[state=open]:animate-pop-in',
            )}
          >
            <S.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-muted-foreground">
              <ChevronUp className="size-4" aria-hidden />
            </S.ScrollUpButton>
            <S.Viewport className="p-1">
              {options.map((o) => (
                <S.Item
                  key={o.value}
                  value={toRadix(o.value)}
                  data-value={o.value}
                  disabled={o.disabled}
                  textValue={o.text}
                  className={cn(
                    'relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-8 pr-3 text-sm outline-none',
                    'data-[highlighted]:bg-muted data-[state=checked]:font-medium',
                    'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                  )}
                >
                  <span className="absolute left-2 flex size-4 items-center justify-center">
                    <S.ItemIndicator>
                      <Check className="size-4 text-accent" aria-hidden />
                    </S.ItemIndicator>
                  </span>
                  <S.ItemText>{o.label}</S.ItemText>
                </S.Item>
              ))}
            </S.Viewport>
            <S.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-muted-foreground">
              <ChevronDown className="size-4" aria-hidden />
            </S.ScrollDownButton>
          </S.Content>
        </S.Portal>
      </S.Root>
      {valueField}
    </div>
  );
}

/** The option list with a search box (substring match, matches highlighted). */
function SearchList({
  triggerRef,
  id,
  className,
  disabled,
  options,
  current,
  selected,
  placeholder,
  aria,
  onPick,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  id?: string;
  className?: string;
  disabled?: boolean;
  options: Option[];
  current: string;
  selected?: Option;
  placeholder?: string;
  aria: Record<string, unknown>;
  onPick: (value: string) => void;
}) {
  const text = useUiText();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // The highlighted option; opening starts on the chosen one.
  const [active, setActive] = useState(toRadix(current));
  const list = useRef<HTMLDivElement>(null);

  function show(open: boolean, typed = '') {
    setOpen(open);
    setSearch(typed);
    if (open) setActive(toRadix(current));
  }

  // Bring the chosen option into view when the list opens.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function onTriggerKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (open || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show(true);
    } else if (e.key.length === 1 && e.key !== ' ') {
      // Typing on the closed field opens the list and starts the search.
      e.preventDefault();
      show(true, e.key);
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => show(o)}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-value={current}
          data-placeholder={selected ? undefined : ''}
          disabled={disabled}
          onKeyDown={onTriggerKey}
          {...aria}
          className={cn(triggerClass, className)}
        >
          <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-56 max-w-[calc(100vw-1rem)] p-0"
      >
        <Command
          loop
          value={active}
          onValueChange={setActive}
          filter={(value, q, keywords = []) => matchScore(q, keywords[0] ?? value)}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={text.search}
              aria-label={text.search}
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List
            ref={list}
            className="scrollbar-hairline max-h-[min(var(--radix-popover-content-available-height),18rem)] overflow-y-auto overscroll-contain p-1"
          >
            <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
              {text.nothingFound}
            </Command.Empty>
            {options.map((o) => (
              <Command.Item
                key={o.value}
                value={toRadix(o.value)}
                keywords={[o.text]}
                disabled={o.disabled}
                onSelect={() => {
                  onPick(o.value);
                  show(false);
                  triggerRef.current?.focus();
                }}
                className={cn(itemClass, 'data-[selected=true]:bg-muted')}
              >
                {o.value === current ? (
                  <Check className="absolute left-2 size-4 text-accent" aria-hidden />
                ) : null}
                <span className={cn('min-w-0 truncate', o.value === current && 'font-medium')}>
                  {typeof o.label === 'string' ? (
                    <Highlight text={o.label} search={search} />
                  ) : (
                    o.label
                  )}
                </span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
