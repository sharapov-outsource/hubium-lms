import { buildModuleCtx, Permissions } from '@hubium/core';
import type { Db } from '@hubium/db';
import { coreHandlers, type JobHandlerDef } from './handlers.ts';
import { serverModules } from './modules.ts';

/** Module cron jobs run with a system ModuleCtx. */
function moduleCron(): JobHandlerDef[] {
  return serverModules.flatMap((m) =>
    (m.cron ?? []).map((c) => ({
      name: c.name,
      cron: c.schedule,
      async handler(_data: never, { db }: { db: Db }) {
        const ctx = {
          db,
          actor: { kind: 'system' as const },
          perm: new Permissions(db, { kind: 'system' }),
          now: new Date(),
          locale: 'ru' as const,
          origin: 'WORKER' as const,
        };
        return db.$transaction((tx) => c.handler(buildModuleCtx(ctx, tx)), { timeout: 120_000 });
      },
    })),
  );
}

export const allHandlers: JobHandlerDef[] = [...coreHandlers, ...moduleCron()];
