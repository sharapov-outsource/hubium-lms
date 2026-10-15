import { defineModuleUI } from '@hubium/module-sdk/ui';
import { BookSettingsFields } from './settings.tsx';
import { BookView } from './view.tsx';

export const bookUI = defineModuleUI({
  key: 'book',
  SettingsFields: BookSettingsFields as never,
  View: BookView as never,
});
