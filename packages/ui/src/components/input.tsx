import { type ComponentProps, cloneElement, isValidElement } from 'react';
import { cn } from '../lib/cn.ts';
import { FileInput } from './file-input.tsx';

/** Shared look of text fields, selects and pickers. */
export const fieldClass =
  'w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50 aria-[invalid=true]:border-destructive';
const field = fieldClass;

export function Input({ className, ...props }: ComponentProps<'input'>) {
  if (props.type === 'file') {
    const { type: _file, ...rest } = props;
    return <FileInput className={className} {...rest} />;
  }
  return <input className={cn(field, 'h-9 py-1', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-24 py-2', className)} {...props} />;
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is passed by callers
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

/** Drawn by the base styles in globals.css, like every checkbox and radio button. */
export function Checkbox(props: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" {...props} />;
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | string[];
  children: React.ReactNode;
  className?: string;
}

type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: unknown };

export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  const errors = Array.isArray(error) ? error : error ? [error] : [];
  const notes = hint || errors.length ? `${htmlFor}-notes` : undefined;
  // the control the label names hears the hint and the errors with it, and is marked invalid
  const control =
    isValidElement<ControlProps>(children) && children.props.id === htmlFor
      ? cloneElement(children, {
          'aria-describedby':
            [children.props['aria-describedby'], notes].filter(Boolean).join(' ') || undefined,
          'aria-invalid': children.props['aria-invalid'] ?? (errors.length ? true : undefined),
        })
      : children;
  return (
    // Label, control and notes sit on the rows of the surrounding grid (subgrid), so fields
    // in one row keep their inputs level whatever the label length or hint below. Exactly
    // three children; outside a grid this is an ordinary stack.
    <div className={cn('row-span-3 grid grid-rows-subgrid content-start gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      <div className="min-w-0">{control}</div>
      {notes ? (
        <div id={notes} className="grid gap-1">
          {hint && !errors.length ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {errors.map((e) => (
            <p key={e} className="text-xs text-destructive" role="alert">
              {e}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
