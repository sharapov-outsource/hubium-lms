import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { registerModuleMessages } from '@hubium/i18n';
import { assignModules } from '@hubium/mod-assign/server';
import { contentModules } from '@hubium/mod-content/server';
import { forumModules } from '@hubium/mod-forum/server';
import { quizModules } from '@hubium/mod-quiz/server';
import { moduleMessages } from './messages';

// Server-side module registry (also imported by the worker). Keep in sync with ./ui.tsx.
export const serverModules = [...contentModules, ...assignModules, ...quizModules, ...forumModules];
registerModules(serverModules as never);
registerModuleMessages(moduleMessages);
