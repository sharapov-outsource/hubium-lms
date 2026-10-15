import { assignUI } from '@hubium/mod-assign/ui';
import { bookUI } from '@hubium/mod-book/ui';
import { choiceUI } from '@hubium/mod-choice/ui';
import { contentModuleUIs } from '@hubium/mod-content/ui';
import { dataUI } from '@hubium/mod-data/ui';
import { feedbackUI } from '@hubium/mod-feedback/ui';
import { forumUI } from '@hubium/mod-forum/ui';
import { glossaryUI } from '@hubium/mod-glossary/ui';
import { lessonUI } from '@hubium/mod-lesson/ui';
import { livesessionUI } from '@hubium/mod-livesession/ui';
import { ltiUI } from '@hubium/mod-lti/ui';
import { quizUI } from '@hubium/mod-quiz/ui';
import { scormUI } from '@hubium/mod-scorm/ui';
import { videoUI } from '@hubium/mod-video/ui';
import { wikiUI } from '@hubium/mod-wiki/ui';
import type { ActivityModuleUI } from '@hubium/module-sdk/ui';

const uis = new Map<string, ActivityModuleUI<never>>();
for (const ui of [
  ...contentModuleUIs,
  bookUI,
  choiceUI,
  feedbackUI,
  glossaryUI,
  lessonUI,
  wikiUI,
  dataUI,
  assignUI,
  quizUI,
  forumUI,
  videoUI,
  livesessionUI,
  scormUI,
  ltiUI,
])
  uis.set(ui.key, ui as unknown as ActivityModuleUI<never>);

export function getModuleUI(key: string): ActivityModuleUI<never> | undefined {
  return uis.get(key);
}

export const moduleUIKeys = [...uis.keys()];
