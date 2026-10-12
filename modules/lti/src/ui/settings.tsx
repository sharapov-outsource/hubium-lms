'use client';

import { useFieldErrors } from '@hubium/module-sdk/form';
import type { SettingsFieldsProps } from '@hubium/module-sdk/ui';
import { Checkbox, Field, Input, Select, Textarea } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { LtiSettingsT } from '../server.ts';

export function LtiSettingsFields({ settings }: SettingsFieldsProps<LtiSettingsT>) {
  const t = useTranslations('mod.lti');
  const [tools, setTools] = useState<{ id: string; name: string }[] | null>(null);
  const toolError = useFieldErrors('settings.toolId');
  useEffect(() => {
    void fetch('/api/mod/lti/tools')
      .then((r) => (r.ok ? r.json() : []))
      .then(setTools, () => setTools([]));
  }, []);
  const current = tools?.some((x) => x.id === settings.toolId) ? settings.toolId : '';
  return (
    <div className="grid gap-4">
      <Field
        label={t('tool')}
        htmlFor="lti-tool"
        error={toolError}
        hint={tools?.length === 0 ? t('noTools') : undefined}
      >
        <Select
          id="lti-tool"
          name="settings.toolId"
          defaultValue={current}
          key={tools ? 'loaded' : 'loading'}
          aria-invalid={!!toolError}
        >
          <option value="">{tools ? t('chooseTool') : '…'}</option>
          {(tools ?? []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('container')} htmlFor="lti-container">
          <Select id="lti-container" name="settings.container" defaultValue={settings.container}>
            <option value="iframe">{t('containers.iframe')}</option>
            <option value="window">{t('containers.window')}</option>
          </Select>
        </Field>
        <Field label={t('height')} htmlFor="lti-height">
          <Input
            id="lti-height"
            name="settings.height"
            type="number"
            min={300}
            defaultValue={settings.height}
          />
        </Field>
      </div>
      <Field label={t('customParams')} htmlFor="lti-custom" hint={t('customHint')}>
        <Textarea
          id="lti-custom"
          name="settings.customParams"
          rows={3}
          defaultValue={settings.customParams}
          className="font-mono text-xs"
        />
      </Field>
      <label htmlFor="lti-sendGrades" className="flex items-center gap-2 text-sm">
        <input type="hidden" name="settings.__bool" value="sendGrades" />
        <Checkbox
          id="lti-sendGrades"
          name="settings.sendGrades"
          defaultChecked={settings.sendGrades}
        />
        {t('sendGrades')}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('gradeMax')} htmlFor="lti-gradeMax">
          <Input
            id="lti-gradeMax"
            name="settings.gradeMax"
            type="number"
            min={1}
            step="any"
            defaultValue={settings.gradeMax}
          />
        </Field>
        <Field label={t('gradePass')} htmlFor="lti-gradePass">
          <Input
            id="lti-gradePass"
            name="settings.gradePass"
            type="number"
            min={0}
            step="any"
            defaultValue={settings.gradePass ?? ''}
          />
        </Field>
      </div>
      {/* preserved fields managed by Deep Linking and AGS */}
      <input type="hidden" name="settings.contentUrl" value={settings.contentUrl} />
      <input type="hidden" name="settings.contentTitle" value={settings.contentTitle} />
    </div>
  );
}
