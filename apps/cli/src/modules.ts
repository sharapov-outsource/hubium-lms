import { parseArgs } from 'node:util';
import {
  ensureSystemContext,
  getAllSettings,
  listModules,
  moduleOverview,
  saveModuleSettings,
} from '@hubium/core';
import type { Db } from '@hubium/db';
import type { Io } from './main.ts';
import { UsageError } from './main.ts';
import { loadApp, systemCtx, withDb } from './system.ts';

/** Turns activity types on or off (Administration → Modules), keeping the others as they are. */
export async function setModules(db: Db, change: { enable?: string[]; disable?: string[] }) {
  await loadApp();
  const known = new Set(listModules().map((m) => m.key));
  const unknown = [...(change.enable ?? []), ...(change.disable ?? [])].filter(
    (k) => !known.has(k),
  );
  if (unknown.length)
    throw new UsageError(
      `Unknown activity type: ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`,
    );
  // the audit log needs the site context, which a database gets from its first seed
  await ensureSystemContext(db);
  const off = new Set((await getAllSettings(db))['modules.disabled']);
  for (const k of change.enable ?? []) off.delete(k);
  for (const k of change.disable ?? []) off.add(k);
  const ctx = await systemCtx(db);
  const rows = await moduleOverview(ctx);
  const required = rows.filter((r) => r.required && off.has(r.key)).map((r) => r.key);
  if (required.length)
    throw new UsageError(`${required.join(', ')} cannot be turned off: imports rely on them.`);
  return saveModuleSettings.run(ctx, {
    enabled: rows.map((r) => r.key).filter((k) => !off.has(k)),
  });
}

export async function modulesCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean' } },
  });
  const [action = 'list', ...keys] = positionals;
  return withDb(async (db) => {
    if (action === 'enable' || action === 'disable') {
      if (!keys.length) throw new UsageError(`hubium modules ${action} needs activity types.`);
      const { disabled } = await setModules(db, { [action]: keys });
      io.out(disabled.length ? `Turned off: ${disabled.join(', ')}` : 'All activity types are on.');
      return 0;
    }
    if (action !== 'list') throw new UsageError(`Unknown action "modules ${action}".`);
    await loadApp();
    const rows = await moduleOverview(await systemCtx(db));
    if (values.json) {
      io.out(JSON.stringify(rows));
      return 0;
    }
    io.out(`${'type'.padEnd(14)}${'state'.padEnd(10)}activities  courses`);
    for (const r of rows)
      io.out(
        `${r.key.padEnd(14)}${(r.required ? 'required' : r.enabled ? 'on' : 'off').padEnd(10)}${String(r.activities).padStart(10)}  ${String(r.courses).padStart(7)}`,
      );
    return 0;
  });
}
