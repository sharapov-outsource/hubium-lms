'use client';

import type { ActionResult } from '@hubium/core/operation';
import { FieldErrorsContext } from '@hubium/module-sdk/form';
import { Alert, Button, type ButtonProps, Field, Input } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useContext, useRef, useState, useTransition } from 'react';

type AnyResult = ActionResult<unknown> | null;
const FormState = createContext<{ result: AnyResult; pending: boolean }>({
  result: null,
  pending: false,
});

/** Whether the form has a field for an error's key (itself, a part of it, or its whole). */
function hasField(form: HTMLFormElement | null, key: string): boolean {
  if (!form) return false;
  for (const el of Array.from(form.elements)) {
    const name = (el as HTMLInputElement).name;
    if (
      name &&
      (name === key ||
        name.startsWith(`${key}.`) ||
        name.startsWith(`${key}[`) ||
        key.startsWith(`${name}.`))
    )
      return true;
  }
  return false;
}

/** Every field error of the surrounding form (for composite inputs). */
export function useFormErrors(): Record<string, string[]> {
  const { result } = useContext(FormState);
  return result && !result.ok ? (result.fieldErrors ?? {}) : {};
}

export function useFieldError(name: string): string[] | undefined {
  const { result } = useContext(FormState);
  return result && !result.ok ? result.fieldErrors?.[name] : undefined;
}

/**
 * Form bound to a server action. Submits via onSubmit (not the `action` prop) so React
 * does not reset the fields when validation fails.
 */
export function ActionForm<T>({
  action,
  children,
  success,
  className,
  resetOnSuccess,
  onSuccess,
  id,
}: {
  action: (fd: FormData) => Promise<ActionResult<T>>;
  children: ReactNode;
  success?: string;
  className?: string;
  resetOnSuccess?: boolean;
  onSuccess?: (data: T) => void;
  id?: string;
}) {
  const t = useTranslations('errors');
  const ref = useRef<HTMLFormElement>(null);
  const [result, setResult] = useState<AnyResult>(null);
  /** Errors no field of the form shows: shown over the form. */
  const [general, setGeneral] = useState<string[]>([]);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // the pressed button's name and value come along, as with a native submit
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    start(async () => {
      const r = await action(fd);
      // Server actions that redirect never resolve here.
      if (!r) return;
      setResult(r);
      if (r.ok) {
        setGeneral([]);
        if (success) toast.success(success);
        if (resetOnSuccess) ref.current?.reset();
        onSuccess?.(r.data);
      } else {
        // the message comes in the page's language and says why
        const fields = Object.entries(r.fieldErrors ?? {});
        const orphans = fields.filter(([k]) => !hasField(ref.current, k)).flatMap(([, v]) => v);
        setGeneral(orphans);
        toast.error(
          orphans[0] ?? (r.code === 'VALIDATION' && fields.length ? t('VALIDATION') : r.message),
        );
        const first = fields.find(([k]) => hasField(ref.current, k))?.[0];
        if (first) (ref.current?.elements.namedItem(first) as HTMLElement | null)?.focus?.();
      }
    });
  }

  return (
    <FormState.Provider value={{ result, pending }}>
      <FieldErrorsContext.Provider value={result && !result.ok ? result.fieldErrors : undefined}>
        <form ref={ref} onSubmit={onSubmit} className={className} id={id} noValidate>
          {general.length ? (
            <Alert variant="destructive" className="col-span-full">
              {general.length > 1 ? (
                <ul className="list-disc pl-5">
                  {general.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : (
                general[0]
              )}
            </Alert>
          ) : null}
          {children}
        </form>
      </FieldErrorsContext.Provider>
    </FormState.Provider>
  );
}

export function SubmitButton({ children, ...props }: ButtonProps) {
  const { pending } = useContext(FormState);
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-busy={pending} {...props}>
      {children}
    </Button>
  );
}

export function FormField({
  name,
  label,
  hint,
  className,
  children,
  ...inputProps
}: { name: string; label: string; hint?: string; className?: string; children?: ReactNode } & Omit<
  React.ComponentProps<'input'>,
  'name' | 'children'
>) {
  const error = useFieldError(name);
  const id = inputProps.id ?? `f-${name}`;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} className={className}>
      {children ?? <Input id={id} name={name} aria-invalid={!!error} {...inputProps} />}
    </Field>
  );
}
