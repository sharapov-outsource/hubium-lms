import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { assignModules } from '@hubium/mod-assign/server';
import { contentModules } from '@hubium/mod-content/server';
import { quizModules } from '@hubium/mod-quiz/server';

// Server-side module registry (also imported by the worker). Keep in sync with ./ui.tsx.
export const serverModules = [...contentModules, ...assignModules, ...quizModules];
registerModules(serverModules as never);
