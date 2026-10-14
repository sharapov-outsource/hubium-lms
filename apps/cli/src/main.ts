import { parseArgs } from 'node:util';

// `hubium <command>`: what an administrator runs on the server besides the web and worker
// processes. Every command takes its settings from the environment (bin/hubium loads
// /etc/hubium/hubium.env) and returns an exit code instead of exiting, so tests call it.

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export class UsageError extends Error {}

const HELP = `Usage: hubium <command> [options]

Commands:
  web                       start the web server (bin/hubium only)
  worker                    start the background worker (bin/hubium only)
  migrate --seed <profile>  apply database migrations, prepare file storage and seed;
                            profile: minimal (administrator only), demo or none
          [--disable-modules a,b]  turn activity types off before seeding
  seed --profile <profile>  seed only: minimal or demo
  doctor [db] [--json]      check the configuration, the database and the services;
                            "db" checks the database only (also before installing)
  modules list [--json]     activity types and whether they are on
  modules enable <key...>   turn activity types on
  modules disable <key...>  turn activity types off (their data is kept)
  secrets rotate            re-encrypt stored secrets after APP_SECRET changed
                            (OLD_APP_SECRET: the previous value)
  maintenance on|off|status [--message <text>] [--until <date-time>] [--json]
                            only site administrators use the site while it is on;
                            --until is the expected end (Retry-After follows it)
  ai reindex [--course <id>] [--sync]
                            rebuild what the AI tutor searches (after changing the
                            embedding model): queued for the worker, or here with --sync
  version [--json]          version, commit and build time

Exit codes: 0 ok, 1 error, 2 warnings only (doctor).`;

type Command = (args: string[], io: Io) => Promise<number>;

const commands: Record<string, () => Promise<Command>> = {
  migrate: async () => (await import('./migrate.ts')).migrateCommand,
  seed: async () => (await import('./migrate.ts')).seedCommand,
  doctor: async () => (await import('./doctor.ts')).doctorCommand,
  modules: async () => (await import('./modules.ts')).modulesCommand,
  secrets: async () => (await import('./secrets.ts')).secretsCommand,
  ai: async () => (await import('./ai.ts')).aiCommand,
  maintenance: async () => (await import('./maintenance.ts')).maintenanceCommand,
  version: async () => versionCommand,
};

export function buildInfo() {
  return {
    version: process.env.HUBIUM_VERSION || '0.0.0',
    commit: process.env.HUBIUM_COMMIT || null,
    builtAt: process.env.HUBIUM_BUILT_AT || null,
    node: process.version,
  };
}

const versionCommand: Command = async (args, io) => {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
  const b = buildInfo();
  if (values.json) io.out(JSON.stringify(b));
  else
    io.out(
      `Hubium LMS ${b.version}${b.commit ? ` (${b.commit})` : ''}${b.builtAt ? `, built ${b.builtAt}` : ''}, Node ${b.node}`,
    );
  return 0;
};

export async function cli(argv: string[], io: Io): Promise<number> {
  const [name, ...args] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    io.out(HELP);
    return name ? 0 : 1;
  }
  if (name === '--version' || name === '-v') return versionCommand([], io);
  const load = commands[name];
  if (!load) {
    io.err(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  try {
    return await (await load())(args, io);
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`${(e as Error).message}\n\nRun "hubium help" for the commands.`);
      return 1;
    }
    // validation errors say which field was wrong (e.g. a seed value that does not fit)
    const fields = (e as { fieldErrors?: Record<string, string[]> }).fieldErrors;
    const detail = fields
      ? `: ${Object.entries(fields)
          .map(([k, v]) => `${k}: ${v.join(', ')}`)
          .join('; ')}`
      : '';
    io.err(`hubium ${name}: ${e instanceof Error ? e.message : String(e)}${detail}`);
    return 1;
  }
}
