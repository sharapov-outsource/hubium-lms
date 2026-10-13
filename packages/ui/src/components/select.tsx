'use client';

import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as S } from 'radix-ui';
import {
  type ChangeEvent,
  Children,
  type ComponentProps,
  Fragment,
  isValidElement,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.ts';
import { useFormReset } from '../lib/use-form-reset.ts';
import { fieldClass } from './input.tsx';

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

export type SelectProps = Omit<ComponentProps<'select'>, 'onChange'> & {
  /** Receives an event whose target carries `value` and `name`, like a native select. */
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  placeholder?: string;
};

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
          aria-invalid={ariaInvalid}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          className={cn(
            fieldClass,
            'flex h-9 items-center justify-between gap-2 py-1 text-left outline-none',
            'focus-visible:border-ring data-[placeholder]:text-muted-foreground',
            className,
          )}
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
      {/* Carries the value into FormData; focusing it (e.g. on a validation error) moves focus
          to the visible trigger. */}
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
    </div>
  );
}
