import { assignModules } from '@hubium/mod-assign/server';
import { bookModules } from '@hubium/mod-book/server';
import { choiceModules } from '@hubium/mod-choice/server';
import { contentModules } from '@hubium/mod-content/server';
import { dataModules } from '@hubium/mod-data/server';
import { feedbackModules } from '@hubium/mod-feedback/server';
import { forumModules } from '@hubium/mod-forum/server';
import { glossaryModules } from '@hubium/mod-glossary/server';
import { h5pModules } from '@hubium/mod-h5p/server';
import { lessonModules } from '@hubium/mod-lesson/server';
import { livesessionModules } from '@hubium/mod-livesession/server';
import { ltiModules } from '@hubium/mod-lti/server';
import { quizModules } from '@hubium/mod-quiz/server';
import { scormModules } from '@hubium/mod-scorm/server';
import { videoModules } from '@hubium/mod-video/server';
import { wikiModules } from '@hubium/mod-wiki/server';
import { workshopModules } from '@hubium/mod-workshop/server';

// The server side of every activity module in this build, registered at startup by web,
// worker, CLI, the seed script and core's tests (core itself never imports modules).
// A new module is added here and to apps/web/src/modules/ui.tsx; see docs/modules.md.
// Which of them users get is decided at run time in Administration → Modules.
export const serverModules = [
  ...contentModules,
  ...bookModules,
  ...choiceModules,
  ...feedbackModules,
  ...glossaryModules,
  ...lessonModules,
  ...wikiModules,
  ...dataModules,
  ...workshopModules,
  ...assignModules,
  ...quizModules,
  ...forumModules,
  ...videoModules,
  ...livesessionModules,
  ...scormModules,
  ...h5pModules,
  ...ltiModules,
];
