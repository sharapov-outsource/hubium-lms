'use client';

import { Upload } from 'lucide-react';
import { type ComponentProps, useRef, useState } from 'react';
import { cn } from '../lib/cn.ts';
import { useFormReset } from '../lib/use-form-reset.ts';
import { useUiText } from './ui-text.tsx';

/**
 * File field in the app's language and style. The native input stays in place, invisible
 * and covering the field, so clicks, drag-and-drop, labels and FormData work as before.
 */
export function FileInput({
  className,
  multiple,
  disabled,
  onChange,
  ...props
}: Omit<ComponentProps<'input'>, 'type'>) {
  const text = useUiText();
  const ref = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  useFormReset(ref, () => setNames([]));
  return (
    <div
      className={cn(
        'relative flex h-9 w-full items-center gap-3 rounded-md border border-input bg-background pl-1 pr-3 text-sm',
        'has-[input:focus-visible]:border-ring has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
        'has-[input[aria-invalid=true]]:border-destructive',
        disabled ? 'opacity-50' : 'hover:bg-muted/40',
        className,
      )}
    >
      <input
        ref={ref}
        type="file"
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          setNames(Array.from(e.target.files ?? [], (f) => f.name));
          onChange?.(e);
        }}
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
      <span
        aria-hidden
        className="pointer-events-none inline-flex h-7 shrink-0 items-center gap-1.5 rounded bg-muted px-2.5 font-medium"
      >
        <Upload className="size-4 text-muted-foreground" />
        {multiple ? text.chooseFiles : text.chooseFile}
      </span>
      <span
        aria-hidden
        className={cn(
          'pointer-events-none min-w-0 truncate',
          !names.length && 'text-muted-foreground',
        )}
      >
        {names.length ? names.join(', ') : multiple ? text.noFiles : text.noFile}
      </span>
    </div>
  );
}
