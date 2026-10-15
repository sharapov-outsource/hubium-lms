import { defineModuleUI } from '@hubium/module-sdk/ui';
import { WikiCompletionFields, WikiSettingsFields } from './settings.tsx';
import { WikiView } from './view.tsx';

export const wikiUI = defineModuleUI({
  key: 'wiki',
  SettingsFields: WikiSettingsFields as never,
  CompletionRulesFields: WikiCompletionFields,
  View: WikiView as never,
});
