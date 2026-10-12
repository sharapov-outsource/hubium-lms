import contentEn from '@hubium/mod-content/messages/en.json' with { type: 'json' };
import contentRu from '@hubium/mod-content/messages/ru.json' with { type: 'json' };

// Module messages live under the `mod` namespace: t('mod.page.name').
export const moduleMessages = {
  ru: { ...contentRu },
  en: { ...contentEn },
};
