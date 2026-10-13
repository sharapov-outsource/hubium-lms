'use client';

import { Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { useFieldError } from '@/components/action-form';

export interface ProfileFieldView {
  shortName: string;
  label: string;
  type: 'text' | 'textarea' | 'checkbox' | 'menu' | 'date';
  choices: string[];
  required: boolean;
  /** Shown but not editable (a locked field on the person's own profile). */
  readOnly?: boolean;
}

/** Inputs for custom profile fields, named `cf_<shortName>` (see profileValuesFromForm). */
export function ProfileFieldInputs({
  fields,
  values,
  emptyChoice = '—',
}: {
  fields: ProfileFieldView[];
  values: Record<string, string | boolean>;
  emptyChoice?: string;
}) {
  return (
    <>
      {fields.map((f) => (
        <ProfileFieldInput
          key={f.shortName}
          field={f}
          value={values[f.shortName]}
          empty={emptyChoice}
        />
      ))}
    </>
  );
}

function ProfileFieldInput({
  field: f,
  value,
  empty,
}: {
  field: ProfileFieldView;
  value: string | boolean | undefined;
  empty: string;
}) {
  const name = `cf_${f.shortName}`;
  const id = `f-${name}`;
  const error = useFieldError(name);
  const text = typeof value === 'string' ? value : '';
  if (f.type === 'checkbox')
    return (
      <div className="grid gap-1">
        <label htmlFor={id} className="flex items-center gap-2 text-sm">
          <Checkbox id={id} name={name} defaultChecked={value === true} disabled={f.readOnly} />
          {f.label}
        </label>
        {error ? <p className="text-xs text-destructive">{error.join(', ')}</p> : null}
      </div>
    );
  const common = {
    id,
    name,
    disabled: f.readOnly,
    required: f.required && !f.readOnly,
    'aria-invalid': !!error,
  };
  return (
    <Field label={f.label} htmlFor={id} error={error}>
      {f.type === 'textarea' ? (
        <Textarea {...common} defaultValue={text} rows={3} />
      ) : f.type === 'menu' ? (
        <Select {...common} defaultValue={text}>
          <option value="">{empty}</option>
          {f.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      ) : (
        <Input {...common} type={f.type === 'date' ? 'date' : 'text'} defaultValue={text} />
      )}
    </Field>
  );
}
