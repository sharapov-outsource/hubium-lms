import { defineModuleUI } from '@hubium/module-sdk/ui';
import { QuizCompletionFields, QuizSettingsFields } from './settings.tsx';
import { QuizView } from './view.tsx';

export const quizUI = defineModuleUI({
  key: 'quiz',
  SettingsFields: QuizSettingsFields as never,
  CompletionRulesFields: QuizCompletionFields,
  View: QuizView as never,
});
