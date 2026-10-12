'use client';

import { EditorField } from '@hubium/editor/field';
import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { useTranslations } from 'next-intl';

export function PageSettings({ settings, courseId }: SettingsFieldsProps<{ content: string }>) {
  const t = useTranslations('mod.page');
  const error = useFieldErrors('settings.content');
  return (
    <EditorField
      name="settings.content"
      label={t('content')}
      defaultValue={settings.content}
      courseId={courseId}
      error={error}
      minHeight={280}
    />
  );
}

export function LabelSettings({ settings, courseId }: SettingsFieldsProps<{ content: string }>) {
  const t = useTranslations('mod.label');
  const error = useFieldErrors('settings.content');
  return (
    <EditorField
      name="settings.content"
      label={t('content')}
      defaultValue={settings.content}
      courseId={courseId}
      error={error}
    />
  );
}
