import { defineModuleUI } from '@hubium/module-sdk/ui';
import { ChoiceCompletionFields, ChoiceSettingsFields } from './settings.tsx';
import { ChoiceView } from './view.tsx';

export const choiceUI = defineModuleUI({
  key: 'choice',
  SettingsFields: ChoiceSettingsFields as never,
  CompletionRulesFields: ChoiceCompletionFields,
  View: ChoiceView as never,
});
