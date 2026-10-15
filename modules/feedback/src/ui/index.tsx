import { defineModuleUI } from '@hubium/module-sdk/ui';
import { FeedbackCompletionFields, FeedbackSettingsFields } from './settings.tsx';
import { FeedbackView } from './view.tsx';

export const feedbackUI = defineModuleUI({
  key: 'feedback',
  SettingsFields: FeedbackSettingsFields as never,
  CompletionRulesFields: FeedbackCompletionFields,
  View: FeedbackView as never,
});
