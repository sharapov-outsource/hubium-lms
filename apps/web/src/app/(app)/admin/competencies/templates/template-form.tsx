import { Checkbox, Textarea } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { saveTemplateAction } from '@/server/actions/competencies';

export async function TemplateForm({
  template,
}: {
  template?: {
    id: string;
    name: string;
    description: string;
    dueDate: Date | null;
    visible: boolean;
  };
}) {
  const [t, tc] = await Promise.all([getTranslations('competencies'), getTranslations('common')]);
  return (
    <ActionForm
      action={saveTemplateAction}
      success={tc('saved')}
      resetOnSuccess={!template}
      className="grid gap-3"
    >
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <FormField
        name="name"
        id="tpl-name"
        label={t('name')}
        defaultValue={template?.name}
        required
      />
      <FormField name="description" id="tpl-description" label={t('description')}>
        <Textarea id="tpl-description" name="description" defaultValue={template?.description} />
      </FormField>
      <FormField
        name="dueDate"
        id="tpl-due"
        type="date"
        label={t('dueDate')}
        defaultValue={template?.dueDate?.toISOString().slice(0, 10)}
        className="w-48"
      />
      <label htmlFor="tpl-visible" className="flex items-center gap-2 text-sm">
        <Checkbox id="tpl-visible" name="visible" defaultChecked={template?.visible ?? true} />
        {t('visible')}
      </label>
      <div>
        <SubmitButton>{template ? tc('save') : tc('create')}</SubmitButton>
      </div>
    </ActionForm>
  );
}
