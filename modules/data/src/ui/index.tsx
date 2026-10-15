import { defineModuleUI } from '@hubium/module-sdk/ui';
import { DataCompletionFields, DataSettingsFields } from './settings.tsx';
import { DatabaseView } from './view.tsx';

export const dataUI = defineModuleUI({
  key: 'data',
  SettingsFields: DataSettingsFields as never,
  CompletionRulesFields: DataCompletionFields,
  View: DatabaseView as never,
});
