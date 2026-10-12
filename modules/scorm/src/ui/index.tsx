import { defineModuleUI } from '@hubium/module-sdk/ui';
import { ScormCompletionFields, ScormSettingsFields } from './settings.tsx';
import { ScormView } from './view.tsx';

export const scormUI = defineModuleUI({
  key: 'scorm',
  SettingsFields: ScormSettingsFields as never,
  CompletionRulesFields: ScormCompletionFields,
  View: ScormView as never,
});
