import { assignUI } from '@hubium/mod-assign/ui';
import { contentModuleUIs } from '@hubium/mod-content/ui';
import { forumUI } from '@hubium/mod-forum/ui';
import { livesessionUI } from '@hubium/mod-livesession/ui';
import { quizUI } from '@hubium/mod-quiz/ui';
import { videoUI } from '@hubium/mod-video/ui';
import type { ActivityModuleUI } from '@hubium/module-sdk/ui';

const uis = new Map<string, ActivityModuleUI<never>>();
for (const ui of [...contentModuleUIs, assignUI, quizUI, forumUI, videoUI, livesessionUI])
  uis.set(ui.key, ui as unknown as ActivityModuleUI<never>);

export function getModuleUI(key: string): ActivityModuleUI<never> | undefined {
  return uis.get(key);
}

export const moduleUIKeys = [...uis.keys()];
