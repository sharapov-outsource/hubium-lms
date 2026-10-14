import { parseArgs } from 'node:util';
import {
  ensureSystemContext,
  getAllSettings,
  maintenanceState,
  setMaintenance,
} from '@hubium/core';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { withDb } from './system.ts';

/**
 * `hubium maintenance on|off|status`: only site administrators use the site while it is on.
 * Web servers notice the change within seconds.
 */
export async function maintenanceCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      message: { type: 'string' },
      until: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const [action = 'status'] = positionals;
  return withDb(async (db) => {
    if (action === 'on' || action === 'off') {
      let until: string | null | undefined;
      if (values.until !== undefined) {
        const d = new Date(values.until);
        if (!values.until || Number.isNaN(d.getTime()))
          throw new UsageError('--until takes a date and time, e.g. 2026-10-20T18:00:00+03:00.');
        until = d.toISOString();
      } else if (action === 'off') until = null;
      await ensureSystemContext(db);
      await setMaintenance(db, { enabled: action === 'on', message: values.message, until });
    } else if (action !== 'status') throw new UsageError(`Unknown action "maintenance ${action}".`);
    const m = maintenanceState(await getAllSettings(db));
    if (values.json) io.out(JSON.stringify({ ...m, until: m.until?.toISOString() ?? null }));
    else {
      io.out(
        m.enabled
          ? 'Maintenance mode is on: only site administrators can use the site.'
          : 'Maintenance mode is off.',
      );
      if (m.enabled && m.message) io.out(`Message: ${m.message}`);
      if (m.enabled && m.until) io.out(`Expected end: ${m.until.toISOString()}`);
    }
    return 0;
  });
}
