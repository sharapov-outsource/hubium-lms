import { createHash } from 'node:crypto';
import { MODEL_INFO } from './generated/model-info.ts';
import type { PrismaClient } from './generated/prisma/client.ts';
import { uuidv7 } from './ids.ts';
import { currentWriteScope, type OpRecord } from './write-scope.ts';

// What an operation writes depends on its input, the database and its context (its time,
// its random numbers, the ids it makes: write-scope.ts), so that the cloud replaying an
// operation a local node ran gets what the node got. This extension gives the rows a query
// creates their uuid(7) ids (uuidv7(), recorded and replayed with the operation) and, in an
// operation recorded or replayed, its time where the schema says now() or @updatedAt,
// nested writes included. For a
// guarded operation a node records, it also keeps each changed row as it was before, which
// the cloud compares with its own (MODEL_INFO comes from scripts/model-info.mjs).

type Data = Record<string, unknown>;

const isObj = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
const each = (v: unknown, fn: (x: unknown) => unknown): unknown =>
  Array.isArray(v) ? v.map(fn) : fn(v);

function fillCreate(model: string, data: unknown, now: Date | undefined): unknown {
  const info = MODEL_INFO[model];
  if (!info || !isObj(data)) return data;
  const out: Data = { ...data };
  const id = info.pk[0];
  if (info.uuid && id && out[id] === undefined) out[id] = uuidv7(Date.now(), model);
  if (now) {
    for (const f of info.now) if (out[f] === undefined) out[f] = now;
    for (const f of info.updatedAt) if (out[f] === undefined) out[f] = now;
  }
  for (const [field, target] of Object.entries(info.rel))
    if (isObj(out[field])) out[field] = fillNested(target, out[field] as Data, now);
  return out;
}

function fillUpdate(model: string, data: unknown, now: Date | undefined): unknown {
  const info = MODEL_INFO[model];
  if (!info || !isObj(data)) return data;
  const out: Data = { ...data };
  if (now) for (const f of info.updatedAt) if (out[f] === undefined) out[f] = now;
  for (const [field, target] of Object.entries(info.rel))
    if (isObj(out[field])) out[field] = fillNested(target, out[field] as Data, now);
  return out;
}

/** A nested write on a relation: its creates and updates filled as the top level's. */
function fillNested(model: string, w: Data, now: Date | undefined): Data {
  const out: Data = { ...w };
  const info = MODEL_INFO[model];
  if (out.create !== undefined) out.create = each(out.create, (x) => fillCreate(model, x, now));
  if (isObj(out.createMany) && out.createMany.data !== undefined)
    out.createMany = {
      ...out.createMany,
      data: each(out.createMany.data, (x) => fillCreate(model, x, now)),
    };
  if (out.connectOrCreate !== undefined)
    out.connectOrCreate = each(out.connectOrCreate, (c) =>
      isObj(c) ? { ...c, create: fillCreate(model, c.create, now) } : c,
    );
  if (out.upsert !== undefined)
    out.upsert = each(out.upsert, (u) =>
      isObj(u)
        ? {
            ...u,
            create: fillCreate(model, u.create, now),
            update: fillUpdate(model, u.update, now),
          }
        : u,
    );
  if (out.update !== undefined)
    out.update = each(out.update, (u) => {
      if (!isObj(u)) return u;
      // { where, data } on a list; on a single relation the fields themselves, or { data }
      const wrapped =
        'where' in u || ('data' in u && Object.keys(u).length === 1 && !info?.dataField);
      return wrapped ? { ...u, data: fillUpdate(model, u.data, now) } : fillUpdate(model, u, now);
    });
  if (out.updateMany !== undefined)
    out.updateMany = each(out.updateMany, (u) =>
      isObj(u) ? { ...u, data: fillUpdate(model, u.data, now) } : u,
    );
  return out;
}

/** A row as text that changes with any of its values: the version a guard compares. */
export function rowHash(row: unknown): string | null {
  if (row === null || row === undefined) return null;
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
    if (v && typeof v === 'object' && 'toFixed' in v && 'd' in v) return String(v);
    if (Array.isArray(v)) return v.map(norm);
    if (isObj(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, norm(v[k])]),
      );
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(norm(row)))
    .digest('base64url');
}

const delegate = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** The primary key of a row, as a where. */
function keyOf(model: string, row: Data): Data {
  const pk = MODEL_INFO[model]?.pk ?? ['id'];
  return Object.fromEntries(pk.map((f) => [f, row[f]]));
}

const CHANGES = new Set(['update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

/** Before a guarded operation changes rows, how they were (read outside its transaction). */
async function guard(
  base: PrismaClient,
  record: OpRecord,
  model: string,
  operation: string,
  args: Data,
): Promise<void> {
  if (!record.guards || !CHANGES.has(operation)) return;
  const d = (base as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)[
    delegate(model)
  ];
  if (!d) return;
  const many = operation === 'updateMany' || operation === 'deleteMany';
  const rows = many
    ? ((await d.findMany!({ where: args.where })) as Data[])
    : [(await d.findUnique!({ where: args.where })) as Data | null].filter((r): r is Data => !!r);
  for (const row of rows) {
    const where = keyOf(model, row);
    const seen = record.guards.some(
      (g) => g.model === model && JSON.stringify(g.where) === JSON.stringify(where),
    );
    // the first version counts: later changes in the same operation are its own
    if (!seen) record.guards.push({ model, where, hash: rowHash(row) });
  }
}

/** The client with the operation context (createDb adds it before the write guard). */
export function withOpContext(client: PrismaClient): PrismaClient {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = currentWriteScope();
          // the operation's time where a node records it or the cloud replays it; elsewhere
          // the database's, as always
          const now = scope?.record || scope?.replay ? scope.now : undefined;
          const a = (args ?? {}) as Data;
          let next: Data = a;
          switch (operation) {
            case 'create':
              next = { ...a, data: fillCreate(model, a.data, now) };
              break;
            case 'createMany':
            case 'createManyAndReturn':
              next = { ...a, data: each(a.data, (x) => fillCreate(model, x, now)) };
              break;
            case 'upsert':
              next = {
                ...a,
                create: fillCreate(model, a.create, now),
                update: fillUpdate(model, a.update, now),
              };
              break;
            case 'update':
            case 'updateMany':
            case 'updateManyAndReturn':
              next = { ...a, data: fillUpdate(model, a.data, now) };
              break;
          }
          if (scope?.record?.guards) await guard(client, scope.record, model, operation, a);
          return query(next as never);
        },
      },
    },
  }) as unknown as PrismaClient;
}
