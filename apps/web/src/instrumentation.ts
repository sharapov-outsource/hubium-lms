import type { Instrumentation } from 'next';

// Startup and server errors as structured log records (see @hubium/log). Next.js still
// prints errors in its own format too; these records add the route, method and digest.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Next.js traces requests, rendering and fetch itself once a provider is registered
  const { startTelemetry } = await import('@hubium/telemetry');
  startTelemetry({ service: process.env.HUBIUM_SERVICE ?? 'web' });
  const { log } = await import('@hubium/log');
  log('next').info(
    { version: process.env.HUBIUM_VERSION, commit: process.env.HUBIUM_COMMIT || undefined },
    'web server starting',
  );
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { log } = await import('@hubium/log');
  const digest =
    typeof err === 'object' && err !== null && 'digest' in err ? String(err.digest) : undefined;
  // No query strings, and the route pattern instead of paths that carry a token.
  const path = context.routePath.includes('[token]')
    ? context.routePath
    : request.path.split('?')[0];
  log('next').error(
    {
      err,
      digest,
      method: request.method,
      path,
      route: context.routePath,
      routeType: context.routeType,
    },
    'request failed',
  );
};
