import { defineModuleUI } from '@hubium/module-sdk/ui';
import { VideoCompletionFields, VideoSettingsFields } from './settings.tsx';
import { VideoView } from './view.tsx';

export const videoUI = defineModuleUI({
  key: 'video',
  SettingsFields: VideoSettingsFields as never,
  CompletionRulesFields: VideoCompletionFields,
  View: VideoView as never,
});
