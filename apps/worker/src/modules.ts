import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { assignModules } from '@hubium/mod-assign/server';
import { contentModules } from '@hubium/mod-content/server';
import { forumModules } from '@hubium/mod-forum/server';
import { livesessionModules } from '@hubium/mod-livesession/server';
import { ltiModules } from '@hubium/mod-lti/server';
import { quizModules } from '@hubium/mod-quiz/server';
import { scormModules } from '@hubium/mod-scorm/server';
import { videoModules } from '@hubium/mod-video/server';

// Same server registry as apps/web/src/modules/server.ts.
export const serverModules = [
  ...contentModules,
  ...assignModules,
  ...quizModules,
  ...forumModules,
  ...videoModules,
  ...livesessionModules,
  ...scormModules,
  ...ltiModules,
];
registerModules(serverModules as never);
