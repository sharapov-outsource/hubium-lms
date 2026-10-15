import { assignModules } from '@hubium/mod-assign/server';
import { bookModules } from '@hubium/mod-book/server';
import { choiceModules } from '@hubium/mod-choice/server';
import { contentModules } from '@hubium/mod-content/server';
import { forumModules } from '@hubium/mod-forum/server';
import { livesessionModules } from '@hubium/mod-livesession/server';
import { ltiModules } from '@hubium/mod-lti/server';
import { quizModules } from '@hubium/mod-quiz/server';
import { scormModules } from '@hubium/mod-scorm/server';
import { videoModules } from '@hubium/mod-video/server';

// The server side of every activity module in this build, registered at startup by web,
// worker, CLI, the seed script and core's tests (core itself never imports modules).
// A new module is added here and to apps/web/src/modules/ui.tsx; see docs/modules.md.
// Which of them users get is decided at run time in Administration → Modules.
export const serverModules = [
  ...contentModules,
  ...bookModules,
  ...choiceModules,
  ...assignModules,
  ...quizModules,
  ...forumModules,
  ...videoModules,
  ...livesessionModules,
  ...scormModules,
  ...ltiModules,
];
