import '@hubium/core/bootstrap';
import { registerModules } from '@hubium/core';
import { registerModuleMessages } from '@hubium/i18n';
import assignEn from '@hubium/mod-assign/messages/en.json' with { type: 'json' };
import assignRu from '@hubium/mod-assign/messages/ru.json' with { type: 'json' };
import { assignModules } from '@hubium/mod-assign/server';
import contentEn from '@hubium/mod-content/messages/en.json' with { type: 'json' };
import contentRu from '@hubium/mod-content/messages/ru.json' with { type: 'json' };
import { contentModules } from '@hubium/mod-content/server';
import forumEn from '@hubium/mod-forum/messages/en.json' with { type: 'json' };
import forumRu from '@hubium/mod-forum/messages/ru.json' with { type: 'json' };
import { forumModules } from '@hubium/mod-forum/server';
import quizEn from '@hubium/mod-quiz/messages/en.json' with { type: 'json' };
import quizRu from '@hubium/mod-quiz/messages/ru.json' with { type: 'json' };
import { quizModules } from '@hubium/mod-quiz/server';

// Same server registry as apps/web/src/modules/server.ts.
export const serverModules = [...contentModules, ...assignModules, ...quizModules, ...forumModules];
registerModules(serverModules as never);
// Notifications created by cron jobs are rendered with module messages.
registerModuleMessages({
  ru: { ...contentRu, ...assignRu, ...quizRu, ...forumRu },
  en: { ...contentEn, ...assignEn, ...quizEn, ...forumEn },
});
