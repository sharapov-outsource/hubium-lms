import { defineModuleUI } from '@hubium/module-sdk/ui';
import { WorkshopCompletionFields, WorkshopSettingsFields } from './settings.tsx';
import { WorkshopView } from './view.tsx';

export const workshopUI = defineModuleUI({
  key: 'workshop',
  SettingsFields: WorkshopSettingsFields as never,
  CompletionRulesFields: WorkshopCompletionFields,
  View: WorkshopView as never,
});
