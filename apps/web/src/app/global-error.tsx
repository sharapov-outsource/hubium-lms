'use client';

// Replaces the root layout when it fails, so no providers or translations are available.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ru">
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
          <h1 style={{ fontSize: '1.25rem' }}>Что-то пошло не так · Something went wrong</h1>
          {error.digest ? (
            <p style={{ fontSize: '0.8rem', color: '#666' }}>
              <code>{error.digest}</code>
            </p>
          ) : null}
          <button type="button" onClick={reset} style={{ padding: '0.5rem 1rem' }}>
            Повторить · Try again
          </button>
        </main>
      </body>
    </html>
  );
}
