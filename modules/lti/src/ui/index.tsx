import { defineModuleUI } from '@hubium/module-sdk/ui';
import { LtiSettingsFields } from './settings.tsx';
import { LtiView } from './view.tsx';

export const ltiUI = defineModuleUI({
  key: 'lti',
  SettingsFields: LtiSettingsFields as never,
  View: LtiView as never,
});
