import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// The API reference page: Scalar's prebuilt browser bundle, served from this origin under
// a strict CSP. The page shares the origin (and the session cookie) with the LMS, so it
// must not run scripts from a CDN, and it talks to nothing but this server.

const BUNDLE = path.join('dist', 'browser', 'standalone.js');

/** Locates @scalar/api-reference's standalone bundle (the package exports hide dist/). */
function bundlePath(): string {
  try {
    const entry = createRequire(import.meta.url).resolve('@scalar/api-reference');
    const p = path.join(path.dirname(path.dirname(entry)), BUNDLE);
    if (existsSync(p)) return p;
  } catch {}
  // Next's standalone output keeps the traced file in pnpm's store layout.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const store = path.join(dir, 'node_modules', '.pnpm');
    if (existsSync(store)) {
      const hit = readdirSync(store).find((d) => d.startsWith('@scalar+api-reference@'));
      const p = hit && path.join(store, hit, 'node_modules', '@scalar', 'api-reference', BUNDLE);
      if (p && existsSync(p)) return p;
    }
    dir = path.dirname(dir);
  }
  throw new Error('@scalar/api-reference bundle not found');
}

let bundle: Promise<{ js: string; hash: string }> | undefined;

/** The bundle and a short hash of it for a cache-busting URL. */
export function scalarBundle() {
  bundle ??= (async () => {
    // Resolved at runtime; next.config.ts adds the bundle to the /api/v1 trace explicitly.
    const js = await readFile(/*turbopackIgnore: true*/ bundlePath(), 'utf8');
    return { js, hash: createHash('sha256').update(js).digest('hex').slice(0, 12) };
  })();
  bundle.catch(() => {
    bundle = undefined;
  });
  return bundle;
}

export const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** No inline script: Scalar reads its settings from the data attributes. */
export function docsPage(opts: { specUrl: string; scriptUrl: string; title: string }): string {
  const config = {
    // system fonts instead of fonts.scalar.com; no telemetry, AI agent or developer tools
    withDefaultFonts: false,
    telemetry: false,
    agent: { disabled: true },
    showDeveloperTools: 'never',
    metaData: { title: opts.title },
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${esc(opts.title)}</title>
  </head>
  <body>
    <script id="api-reference" type="application/json" data-url="${esc(opts.specUrl)}" data-configuration="${esc(JSON.stringify(config))}"></script>
    <script src="${esc(opts.scriptUrl)}"></script>
  </body>
</html>
`;
}
