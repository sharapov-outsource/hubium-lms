import { defineModuleUI } from '@hubium/module-sdk/ui';
import { GlossaryCompletionFields, GlossarySettingsFields } from './settings.tsx';
import { GlossaryView } from './view.tsx';

export const glossaryUI = defineModuleUI({
  key: 'glossary',
  SettingsFields: GlossarySettingsFields as never,
  CompletionRulesFields: GlossaryCompletionFields,
  View: GlossaryView as never,
});
