import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../settings/settings.ts';
import { maintenanceState, openDuringMaintenance, retryAfterSeconds } from './maintenance.ts';

describe('maintenance mode', () => {
  it('keeps signing in and health checks open', () => {
    for (const p of ['/login', '/two-factor', '/api/auth/sign-in/email', '/api/health', '/_next/x'])
      expect(openDuringMaintenance(p)).toBe(true);
    for (const p of ['/', '/dashboard', '/api/v1/me', '/register', '/course/x'])
      expect(openDuringMaintenance(p)).toBe(false);
  });

  it('asks clients to come back when the work is expected to end', () => {
    const s = defaultSettings();
    expect(maintenanceState(s)).toEqual({ enabled: false, message: '', until: null });
    const now = new Date('2026-10-20T12:00:00Z');
    const m = maintenanceState({
      ...s,
      'maintenance.enabled': true,
      'maintenance.until': '2026-10-20T13:00:00Z',
    });
    expect(retryAfterSeconds(m, now)).toBe(3600);
    // an end in the past still asks for a minute; no end, ten minutes
    expect(retryAfterSeconds(m, new Date('2026-10-21T00:00:00Z'))).toBe(60);
    expect(retryAfterSeconds({ ...m, until: null }, now)).toBe(600);
  });
});
