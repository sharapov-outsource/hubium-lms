import { defineModuleUI } from '@hubium/module-sdk/ui';
import { LessonCompletionFields, LessonSettingsFields } from './settings.tsx';
import { LessonView } from './view.tsx';

export const lessonUI = defineModuleUI({
  key: 'lesson',
  SettingsFields: LessonSettingsFields as never,
  CompletionRulesFields: LessonCompletionFields,
  View: LessonView as never,
});
