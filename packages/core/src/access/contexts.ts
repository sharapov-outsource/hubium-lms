import { type ContextLevel, type Db, type Prisma, SYSTEM_CONTEXT_ID } from '@hubium/db';
import { NotFoundError } from '../errors.ts';
import { invalidatePermissionCaches } from './permissions.ts';

type Tx = Prisma.TransactionClient | Db;

export async function ensureSystemContext(db: Tx): Promise<void> {
  await db.context.upsert({
    where: { id: SYSTEM_CONTEXT_ID },
    create: { id: SYSTEM_CONTEXT_ID, level: 'SYSTEM', ancestorIds: [], depth: 0 },
    update: {},
  });
}

/** Creates the context row an entity shares its id with. */
export async function createContext(
  db: Tx,
  id: string,
  level: ContextLevel,
  parentId: string,
): Promise<void> {
  const parent = await db.context.findUnique({ where: { id: parentId } });
  if (!parent) throw new NotFoundError('Parent context');
  await db.context.create({
    data: {
      id,
      level,
      parentId,
      ancestorIds: [...parent.ancestorIds, parent.id],
      depth: parent.depth + 1,
    },
  });
}

/** Moves a context subtree under a new parent, rewriting every descendant in one statement. */
export async function moveContext(db: Tx, id: string, newParentId: string): Promise<void> {
  const [node, parent] = await Promise.all([
    db.context.findUnique({ where: { id } }),
    db.context.findUnique({ where: { id: newParentId } }),
  ]);
  if (!node || !parent) throw new NotFoundError('Context');
  if (parent.ancestorIds.includes(id) || parent.id === id) {
    throw new Error('Cannot move a context into its own subtree');
  }
  const newPrefix = [...parent.ancestorIds, parent.id];
  const oldLen = node.ancestorIds.length;
  // Descendants: replace the first oldLen ancestors with newPrefix.
  await db.$executeRaw`
    UPDATE "Context"
       SET "ancestorIds" = ${newPrefix}::uuid[] || "ancestorIds"[${oldLen + 1}:],
           "depth" = ${newPrefix.length} + (array_length("ancestorIds", 1) - ${oldLen})
     WHERE "ancestorIds" @> ARRAY[${id}]::uuid[]`;
  await db.context.update({
    where: { id },
    data: { parentId: newParentId, ancestorIds: newPrefix, depth: newPrefix.length },
  });
  invalidatePermissionCaches('contexts');
}
