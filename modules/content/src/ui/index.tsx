import { defineModuleUI } from '@hubium/module-sdk/ui';
import { FileSettings } from './file';
import { LabelSettings, PageSettings } from './page';
import { UrlSettings } from './url';
import { FileView, LabelInline, PageView, UrlView } from './views';

export const pageUI = defineModuleUI({
  key: 'page',
  SettingsFields: PageSettings,
  View: PageView as never,
});
export const urlUI = defineModuleUI({
  key: 'url',
  SettingsFields: UrlSettings as never,
  View: UrlView as never,
});
export const labelUI = defineModuleUI({
  key: 'label',
  SettingsFields: LabelSettings,
  View: LabelInline as never,
  Inline: LabelInline as never,
});
export const fileUI = defineModuleUI({
  key: 'file',
  SettingsFields: FileSettings as never,
  View: FileView as never,
});

export const contentModuleUIs = [pageUI, urlUI, labelUI, fileUI];
