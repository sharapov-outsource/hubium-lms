import { buildModuleCtx, Permissions } from '@hubium/core';
import type { Db } from '@hubium/db';
import { coreHandlers, type JobHandlerDef } from './handlers.ts';
import { serverModules } from './modules.ts';

function systemCtx(db: Db) {
  return {
    db,
    actor: { kind: 'system' as const },
    perm: new Permissions(db, { kind: 'system' }),
    now: new Date(),
    locale: 'ru' as const,
    origin: 'WORKER' as const,
  };
}

/** Module cron jobs run with a system ModuleCtx inside a transaction. */
function moduleCron(): JobHandlerDef[] {
  return serverModules.flatMap((m) =>
    (m.cron ?? []).map((c) => ({
      name: c.name,
      cron: c.schedule,
      async handler(_data: never, { db }: { db: Db }) {
        return db.$transaction((tx) => c.handler(buildModuleCtx(systemCtx(db), tx)), {
          timeout: 120_000,
        });
      },
    })),
  );
}

/** Module jobs (long-running, e.g. transcoding) run without a wrapping transaction. */
function moduleJobs(): JobHandlerDef[] {
  return serverModules.flatMap((m) =>
    (m.jobs ?? []).map((j) => ({
      name: j.name,
      queue: j.queue ?? 'default',
      async handler(data: never, { db }: { db: Db }) {
        return j.handler(buildModuleCtx(systemCtx(db)), data);
      },
    })),
  );
}

export const allHandlers: JobHandlerDef[] = [...coreHandlers, ...moduleCron(), ...moduleJobs()];
