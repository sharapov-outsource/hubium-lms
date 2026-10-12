import { defineModuleUI } from '@hubium/module-sdk/ui';
import { LiveCompletionFields, LiveSettingsFields } from './settings.tsx';
import { LiveView } from './view.tsx';

export const livesessionUI = defineModuleUI({
  key: 'livesession',
  SettingsFields: LiveSettingsFields as never,
  CompletionRulesFields: LiveCompletionFields,
  View: LiveView as never,
});
