import type { Db } from '@hubium/db';
import { logEvent } from '../events/log.ts';
import { type AllSettings, setSettings } from '../settings/settings.ts';

// Maintenance mode, as in Moodle: while it is on only site administrators use the site.
// Everyone else gets a 503 page (and the REST API a 503 answer) with the administrator's
// message; signing in stays open so that administrators can get in.

export interface MaintenanceState {
  enabled: boolean;
  message: string;
  until: Date | null;
}

export function maintenanceState(s: AllSettings): MaintenanceState {
  const until = s['maintenance.until'] ? new Date(s['maintenance.until']) : null;
  return {
    enabled: s['maintenance.enabled'],
    message: s['maintenance.message'],
    until: until && !Number.isNaN(until.getTime()) ? until : null,
  };
}

/** Seconds for Retry-After: until the expected end, else ten minutes (at least a minute). */
export function retryAfterSeconds(m: MaintenanceState, now = new Date()): number {
  if (!m.until) return 600;
  return Math.max(60, Math.ceil((m.until.getTime() - now.getTime()) / 1000));
}

/** Paths that stay open: signing in, health checks, assets. */
const OPEN = [
  '/login',
  '/two-factor',
  '/api/auth',
  '/api/health',
  '/api/metrics',
  '/_next',
  '/favicon',
  '/branding',
  '/manifest.webmanifest',
  '/sw.js',
  '/icons/',
  '/offline',
];

export function openDuringMaintenance(pathname: string): boolean {
  return OPEN.some((p) => pathname.startsWith(p));
}

/** Turns maintenance mode on or off (the settings page, `hubium maintenance`). */
export async function setMaintenance(
  db: Db,
  input: { enabled: boolean; message?: string; until?: string | null },
  actorId?: string | null,
) {
  await setSettings(
    db,
    {
      'maintenance.enabled': input.enabled,
      ...(input.message !== undefined ? { 'maintenance.message': input.message } : {}),
      ...(input.until !== undefined ? { 'maintenance.until': input.until } : {}),
    },
    actorId ?? undefined,
  );
  await logEvent(db, {
    name: input.enabled ? 'maintenance.enabled' : 'maintenance.disabled',
    actorId: actorId ?? null,
    origin: actorId ? 'WEB' : 'CLI',
  });
}
