import type { Db, Prisma } from '@hubium/db';
import { type InstalledPack, installPacks } from '@hubium/i18n/packs';
import { log } from '@hubium/log';

// Language packs installed from Administration → Languages live in the database; each
// process loads them before it reads the settings (which name languages), and again when
// any process changes them (cache topic "languages").

const logger = log('i18n');

type Tree = Record<string, unknown>;

let loading: Promise<void> | undefined;

/** The packs as a process holds them: core strings and one object per module. */
export function packOf(row: { code: string; core: unknown; modules: unknown }): InstalledPack {
  const modules = (row.modules ?? {}) as Record<string, Tree>;
  return { code: row.code, core: (row.core ?? {}) as Tree, modules: Object.values(modules) };
}

/** Loads the installed packs into this process. */
export async function loadLanguagePacks(db: Db | Prisma.TransactionClient): Promise<void> {
  const rows = await db.languagePack.findMany();
  installPacks(rows.map(packOf));
}

/**
 * Loads the installed packs once (until they change). A failure leaves the bundled
 * languages in place and is tried again on the next call.
 */
export function ensureLanguagePacks(db: Db | Prisma.TransactionClient): Promise<void> {
  loading ??= loadLanguagePacks(db).catch((e: unknown) => {
    logger.warn({ err: e }, 'installed language packs not loaded');
    loading = undefined;
  });
  return loading;
}

export function invalidateLanguagePacks(): void {
  loading = undefined;
}
