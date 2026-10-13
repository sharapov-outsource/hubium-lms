'use client';

// Replaces the root layout when it fails, so no providers or language packs are available:
// the two strings of this page are kept here. A language without them gets English.
const TEXT: Record<string, { title: string; retry: string }> = {
  en: { title: 'Something went wrong', retry: 'Try again' },
  ru: { title: 'Что-то пошло не так', retry: 'Повторить' },
  de: { title: 'Etwas ist schiefgelaufen', retry: 'Erneut versuchen' },
  fr: { title: 'Une erreur s’est produite', retry: 'Réessayer' },
  it: { title: 'Si è verificato un errore', retry: 'Riprova' },
};

/** The language chosen on the site (cookie), else the browser's. */
function pageLanguage(): string {
  if (typeof document === 'undefined') return 'en';
  const chosen = document.cookie.match(/(?:^|;\s*)hubium-locale=([^;]+)/)?.[1];
  const lang = (chosen ?? navigator.language ?? 'en').toLowerCase();
  return TEXT[lang] ? lang : (lang.split('-')[0] ?? 'en');
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const lang = pageLanguage();
  const text = TEXT[lang] ?? TEXT.en!;
  return (
    <html lang={TEXT[lang] ? lang : 'en'}>
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
          textAlign: 'center',
        }}
      >
        <main>
          <h1 style={{ fontSize: '1.25rem' }}>{text.title}</h1>
          {error.digest ? (
            <p style={{ fontSize: '0.8rem', color: '#666' }}>
              <code>{error.digest}</code>
            </p>
          ) : null}
          <button type="button" onClick={reset} style={{ padding: '0.5rem 1rem' }}>
            {text.retry}
          </button>
        </main>
      </body>
    </html>
  );
}
