import assignEn from '@hubium/mod-assign/messages/en.json' with { type: 'json' };
import assignRu from '@hubium/mod-assign/messages/ru.json' with { type: 'json' };
import contentEn from '@hubium/mod-content/messages/en.json' with { type: 'json' };
import contentRu from '@hubium/mod-content/messages/ru.json' with { type: 'json' };
import forumEn from '@hubium/mod-forum/messages/en.json' with { type: 'json' };
import forumRu from '@hubium/mod-forum/messages/ru.json' with { type: 'json' };
import liveEn from '@hubium/mod-livesession/messages/en.json' with { type: 'json' };
import liveRu from '@hubium/mod-livesession/messages/ru.json' with { type: 'json' };
import quizEn from '@hubium/mod-quiz/messages/en.json' with { type: 'json' };
import quizRu from '@hubium/mod-quiz/messages/ru.json' with { type: 'json' };
import videoEn from '@hubium/mod-video/messages/en.json' with { type: 'json' };
import videoRu from '@hubium/mod-video/messages/ru.json' with { type: 'json' };

// Module messages live under the `mod` namespace: t('mod.page.name').
export const moduleMessages = {
  ru: { ...contentRu, ...assignRu, ...quizRu, ...forumRu, ...videoRu, ...liveRu },
  en: { ...contentEn, ...assignEn, ...quizEn, ...forumEn, ...videoEn, ...liveEn },
};
