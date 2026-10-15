'use client';

import type { ProfileField } from '@hubium/core/users/profile-fields';
import { useConfirm } from '@hubium/module-sdk/form';
import { Button, Checkbox, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { type LanguageOption, LocalizedFields } from '@/components/localized-fields';
import { profileFieldCommandAction, saveProfileFieldAction } from '@/server/actions/profile-fields';

const TYPES = ['text', 'textarea', 'checkbox', 'menu', 'date'] as const;

export function ProfileFieldForm({
  field,
  languages,
}: {
  field?: ProfileField;
  /** Languages of the label: the site language first. */
  languages: LanguageOption[];
}) {
  const t = useTranslations('profileFields');
  const tc = useTranslations('common');
  const sfx = field?.id ?? 'new';
  const [type, setType] = useState<string>(field?.type ?? 'text');
  const flag = (name: 'required' | 'locked' | 'visibleToOthers') => (
    <label htmlFor={`f-${name}-${sfx}`} className="flex items-center gap-2 text-sm">
      <Checkbox id={`f-${name}-${sfx}`} name={name} defaultChecked={field?.[name]} />
      {t(name)}
    </label>
  );
  return (
    <ActionForm
      action={saveProfileFieldAction}
      success={t('saved')}
      resetOnSuccess={!field}
      className="grid gap-4"
    >
      {field ? <input type="hidden" name="id" value={field.id} /> : null}
      <FormField
        id={`f-shortName-${sfx}`}
        name="shortName"
        label={t('shortName')}
        hint={t('shortNameHint')}
        defaultValue={field?.shortName}
        required
      />
      <LocalizedFields
        name="name"
        label={t('name')}
        languages={languages}
        values={field?.name}
        idSuffix={`-${sfx}`}
        maxLength={100}
      />
      <FormField id={`f-type-${sfx}`} name="type" label={t('type')}>
        <Select
          id={`f-type-${sfx}`}
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="max-w-xs"
        >
          {TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`types.${k}`)}
            </option>
          ))}
        </Select>
      </FormField>
      {type === 'menu' ? (
        <FormField id={`f-choices-${sfx}`} name="choices" label={t('choices')}>
          <Textarea
            id={`f-choices-${sfx}`}
            name="choices"
            rows={4}
            defaultValue={field?.choices.join('\n')}
          />
        </FormField>
      ) : null}
      <div className="grid gap-2">
        {flag('required')}
        {flag('locked')}
        {flag('visibleToOthers')}
      </div>
      <SubmitButton className="w-fit" variant={field ? 'secondary' : 'primary'}>
        {field ? tc('save') : tc('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function FieldCommands({
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
  const t = useTranslations('profileFields');
  const tc = useTranslations('common');
  const tco = useTranslations('course');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const run = async (cmd: 'up' | 'down' | 'delete') => {
    if (cmd === 'delete' && !(await confirm(t('deleteConfirm', { name })))) return;
    start(async () => {
      const r = await profileFieldCommandAction(id, cmd);
      if (!r.ok) toast.error(r.message);
      router.refresh();
    });
  };
  return (
    <span className="flex gap-1">
      {confirmDialog}
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveUp')}: ${name}`}
        disabled={pending || first}
        onClick={() => void run('up')}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tco('moveDown')}: ${name}`}
        disabled={pending || last}
        onClick={() => void run('down')}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${tc('delete')}: ${name}`}
        disabled={pending}
        onClick={() => void run('delete')}
      >
        <Trash2 />
      </Button>
    </span>
  );
}
