import { getAllSettings, isModuleEnabled } from '@hubium/core';
import { db } from './db';

// Origins of enabled LTI tools for the CSP frame-src/form-action lists, cached briefly;
// none while the LTI activity type is turned off.
let cache: { at: number; origins: string[] } | undefined;

export async function ltiOrigins(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.origins;
  if (!isModuleEnabled(await getAllSettings(db), 'lti')) {
    cache = { at: Date.now(), origins: [] };
    return cache.origins;
  }
  // every address a tool's frame goes to: login, launch, redirect and deep linking, and
  // the content activities picked by deep linking
  const [tools, picked] = await Promise.all([
    db.ltiTool
      .findMany({
        where: { enabled: true },
        select: {
          oidcLoginUrl: true,
          targetLinkUri: true,
          redirectUris: true,
          deepLinkingUrl: true,
        },
      })
      .catch(() => []),
    db.activity
      .findMany({ where: { moduleKey: 'lti', deletedAt: null }, select: { settings: true } })
      .catch(() => []),
  ]);
  const origins = new Set<string>();
  const add = (u: unknown) => {
    if (typeof u !== 'string' || !u) return;
    try {
      const url = new URL(u);
      if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
    } catch {}
  };
  for (const t of tools)
    for (const u of [t.oidcLoginUrl, t.targetLinkUri, t.deepLinkingUrl, ...t.redirectUris]) add(u);
  for (const a of picked) add((a.settings as { contentUrl?: unknown } | null)?.contentUrl);
  cache = { at: Date.now(), origins: [...origins] };
  return cache.origins;
}
