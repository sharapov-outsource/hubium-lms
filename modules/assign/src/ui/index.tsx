import { defineModuleUI } from '@hubium/module-sdk/ui';
import { AssignCompletionFields, AssignSettingsFields } from './settings.tsx';
import { AssignView } from './view.tsx';

export const assignUI = defineModuleUI({
  key: 'assign',
  SettingsFields: AssignSettingsFields as never,
  CompletionRulesFields: AssignCompletionFields,
  View: AssignView as never,
});
