'use client';

import type { CourseField } from '@hubium/core/courses/course-fields';
import { Button, Checkbox, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { type LanguageOption, LocalizedFields } from '@/components/localized-fields';
import { courseFieldCommandAction, saveCourseFieldAction } from '@/server/actions/course-fields';

const TYPES = ['text', 'textarea', 'checkbox', 'menu', 'date'] as const;

export function CourseFieldForm({
  field,
  languages,
}: {
  field?: CourseField;
  /** Languages of the label: the site language first. */
  languages: LanguageOption[];
}) {
  const t = useTranslations('courseFields');
  const tp = useTranslations('profileFields');
  const tc = useTranslations('common');
  const sfx = field?.id ?? 'new';
  const [type, setType] = useState<string>(field?.type ?? 'text');
  const flag = (name: 'required' | 'locked' | 'visible', label: string, checked?: boolean) => (
    <label htmlFor={`cf-${name}-${sfx}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`cf-${name}-${sfx}`} name={name} defaultChecked={checked} />
      {label}
    </label>
  );
  return (
    <ActionForm
      action={saveCourseFieldAction}
      success={tp('saved')}
      resetOnSuccess={!field}
      className="grid gap-4"
    >
      {field ? <input type="hidden" name="id" value={field.id} /> : null}
      <FormField
        id={`cf-shortName-${sfx}`}
        name="shortName"
        label={tp('shortName')}
        hint={t('shortNameHint')}
        defaultValue={field?.shortName}
        required
      />
      <LocalizedFields
        name="name"
        label={tp('name')}
        languages={languages}
        values={field?.name}
        idSuffix={`-${sfx}`}
        maxLength={100}
      />
      <FormField id={`cf-type-${sfx}`} name="type" label={tp('type')}>
        <Select
          id={`cf-type-${sfx}`}
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="max-w-xs"
        >
          {TYPES.map((k) => (
            <option key={k} value={k}>
              {tp(`types.${k}`)}
            </option>
          ))}
        </Select>
      </FormField>
      {type === 'menu' ? (
        <FormField id={`cf-choices-${sfx}`} name="choices" label={tp('choices')}>
          <Textarea
            id={`cf-choices-${sfx}`}
            name="choices"
            rows={4}
            defaultValue={field?.choices.join('\n')}
          />
        </FormField>
      ) : null}
      <div className="grid gap-2">
        {flag('required', tp('required'), field?.required)}
        {flag('locked', t('locked'), field?.locked)}
        {flag('visible', t('visible'), field?.visible ?? true)}
      </div>
      <SubmitButton className="w-fit" variant={field ? 'secondary' : 'primary'}>
        {field ? tc('save') : tc('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function CourseFieldCommands({
  id,
  name,
  first,
  last,
}: {
  id: string;
  name: string;
  first: boolean;
  last: boolean;
}) {
  const t = useTranslations('courseFields');
  const tc = useTranslations('common');
  const tco = useTranslations('course');
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (cmd: 'up' | 'down' | 'delete') =>
    start(async () => {
      if (cmd === 'delete' && !window.confirm(t('deleteConfirm', { name }))) return;
      const r = await courseFieldCommandAction(id, cmd);
      if (!r.ok) toast.error(r.message);
      router.refresh();
    });
  return (
    <span className="flex gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveUp')}: ${name}`}
        disabled={pending || first}
        onClick={() => run('up')}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveDown')}: ${name}`}
        disabled={pending || last}
        onClick={() => run('down')}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tc('delete')}: ${name}`}
        disabled={pending}
        onClick={() => run('delete')}
      >
        <Trash2 />
      </Button>
    </span>
  );
}
