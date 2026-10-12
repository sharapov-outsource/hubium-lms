import { defineModuleUI } from '@hubium/module-sdk/ui';
import { ForumCompletionFields, ForumSettingsFields } from './settings.tsx';
import { ForumView } from './view.tsx';

export const forumUI = defineModuleUI({
  key: 'forum',
  SettingsFields: ForumSettingsFields as never,
  CompletionRulesFields: ForumCompletionFields,
  View: ForumView as never,
});
