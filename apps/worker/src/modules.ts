import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { assignModules } from '@hubium/mod-assign/server';
import { contentModules } from '@hubium/mod-content/server';
import { quizModules } from '@hubium/mod-quiz/server';

// Same server registry as apps/web/src/modules/server.ts.
export const serverModules = [...contentModules, ...assignModules, ...quizModules];
registerModules(serverModules as never);
