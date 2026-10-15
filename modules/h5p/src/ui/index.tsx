import { defineModuleUI } from '@hubium/module-sdk/ui';
import { H5pCompletionFields, H5pSettingsFields } from './settings.tsx';
import { H5pView } from './view.tsx';

export const h5pUI = defineModuleUI({
  key: 'h5p',
  SettingsFields: H5pSettingsFields as never,
  CompletionRulesFields: H5pCompletionFields,
  View: H5pView as never,
});
