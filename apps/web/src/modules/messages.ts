import assignEn from '@hubium/mod-assign/messages/en.json' with { type: 'json' };
import assignRu from '@hubium/mod-assign/messages/ru.json' with { type: 'json' };
import contentEn from '@hubium/mod-content/messages/en.json' with { type: 'json' };
import contentRu from '@hubium/mod-content/messages/ru.json' with { type: 'json' };
import quizEn from '@hubium/mod-quiz/messages/en.json' with { type: 'json' };
import quizRu from '@hubium/mod-quiz/messages/ru.json' with { type: 'json' };

// Module messages live under the `mod` namespace: t('mod.page.name').
export const moduleMessages = {
  ru: { ...contentRu, ...assignRu, ...quizRu },
  en: { ...contentEn, ...assignEn, ...quizEn },
};
