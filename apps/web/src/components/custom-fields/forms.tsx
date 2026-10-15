'use client';

import type { CourseField } from '@hubium/core/courses/course-fields';
import type { ProfileField } from '@hubium/core/users/profile-fields';
import { useConfirm } from '@hubium/module-sdk/form';
import { Button, Select, Textarea } from '@hubium/ui';
import { toast } from '@hubium/ui/theme';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { ActionForm, FormField, SubmitButton, ToggleField } from '@/components/action-form';
import { type LanguageOption, LocalizedFields } from '@/components/localized-fields';
import { courseFieldCommandAction, saveCourseFieldAction } from '@/server/actions/course-fields';
import { profileFieldCommandAction, saveProfileFieldAction } from '@/server/actions/profile-fields';

// The forms of the site's own fields of courses and of user profiles: the same but for the
// flags (a course field may be shown in the catalog, a profile field to other people).

export type FieldKind = 'course' | 'profile';

const TYPES = ['text', 'textarea', 'checkbox', 'menu', 'date'] as const;

const ACTIONS = {
  course: { save: saveCourseFieldAction, command: courseFieldCommandAction, id: 'cf' },
  profile: { save: saveProfileFieldAction, command: profileFieldCommandAction, id: 'f' },
} as const;

export function FieldForm({
  kind,
  field,
  languages,
}: {
  kind: FieldKind;
  field?: CourseField | ProfileField;
  /** Languages of the label: the site language first. */
  languages: LanguageOption[];
}) {
  const tp = useTranslations('profileFields');
  const tcf = useTranslations('courseFields');
  const tc = useTranslations('common');
  const sfx = field?.id ?? 'new';
  const id = (name: string) => `${ACTIONS[kind].id}-${name}-${sfx}`;
  const [type, setType] = useState<string>(field?.type ?? 'text');
  const flags: [name: string, label: string, checked: boolean | undefined][] =
    kind === 'course'
      ? [
          ['required', tp('required'), field?.required],
          ['locked', tcf('locked'), field?.locked],
          ['visible', tcf('visible'), field && 'visible' in field ? field.visible : true],
        ]
      : [
          ['required', tp('required'), field?.required],
          ['locked', tp('locked'), field?.locked],
          [
            'visibleToOthers',
            tp('visibleToOthers'),
            field && 'visibleToOthers' in field ? field.visibleToOthers : undefined,
          ],
        ];
  return (
    <ActionForm
      action={ACTIONS[kind].save}
      success={tp('saved')}
      resetOnSuccess={!field}
      className="grid gap-4"
    >
      {field ? <input type="hidden" name="id" value={field.id} /> : null}
      <FormField
        id={id('shortName')}
        name="shortName"
        label={tp('shortName')}
        hint={kind === 'course' ? tcf('shortNameHint') : tp('shortNameHint')}
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
      <FormField id={id('type')} name="type" label={tp('type')}>
        <Select
          id={id('type')}
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
        <FormField id={id('choices')} name="choices" label={tp('choices')}>
          <Textarea
            id={id('choices')}
            name="choices"
            rows={4}
            defaultValue={field?.choices.join('\n')}
          />
        </FormField>
      ) : null}
      <div className="grid gap-2">
        {flags.map(([name, label, checked]) => (
          <ToggleField key={name} id={id(name)} name={name} label={label} checked={checked} />
        ))}
      </div>
      <SubmitButton className="w-fit" variant={field ? 'secondary' : 'primary'}>
        {field ? tc('save') : tc('create')}
      </SubmitButton>
    </ActionForm>
  );
}

export function FieldCommands({
  kind,
  id,
  name,
  first,
  last,
}: {
  kind: FieldKind;
  id: string;
  name: string;
  first: boolean;
  last: boolean;
}) {
  const tp = useTranslations('profileFields');
  const tcf = useTranslations('courseFields');
  const tc = useTranslations('common');
  const tco = useTranslations('course');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, confirmDialog] = useConfirm();
  const run = async (cmd: 'up' | 'down' | 'delete') => {
    const question =
      kind === 'course' ? tcf('deleteConfirm', { name }) : tp('deleteConfirm', { name });
    if (cmd === 'delete' && !(await confirm(question))) return;
    start(async () => {
      const r = await ACTIONS[kind].command(id, cmd);
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
