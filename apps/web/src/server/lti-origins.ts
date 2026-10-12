import { db } from './db';

// Origins of enabled LTI tools for the CSP frame-src/form-action lists, cached briefly.
let cache: { at: number; origins: string[] } | undefined;

export async function ltiOrigins(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.origins;
  const tools = await db.ltiTool
    .findMany({ where: { enabled: true }, select: { oidcLoginUrl: true, targetLinkUri: true } })
    .catch(() => []);
  const origins = new Set<string>();
  for (const t of tools)
    for (const u of [t.oidcLoginUrl, t.targetLinkUri])
      try {
        origins.add(new URL(u).origin);
      } catch {}
  cache = { at: Date.now(), origins: [...origins] };
  return cache.origins;
}
