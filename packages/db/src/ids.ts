import { currentWriteScope } from './write-scope.ts';

/** Fixed id of the SYSTEM context (root of the context tree). */
export const SYSTEM_CONTEXT_ID = '00000000-0000-7000-8000-000000000001';

/**
 * RFC 9562 UUIDv7: 48-bit ms timestamp + random bits. Sorts by creation time. In an
 * operation a local node records, the id is recorded under its model; in the cloud's replay
 * of it, the recorded one comes back (write-scope.ts), so rows get the ids people saw on the
 * node. `model` names the model of the row the id is for (the client's defaults pass it).
 */
export function uuidv7(now: number = Date.now(), model = '#'): string {
  const scope = currentWriteScope();
  const replay = scope?.replay;
  if (replay) {
    const k = replay.next[model] ?? 0;
    const id = replay.ids[model]?.[k];
    if (id) {
      replay.next[model] = k + 1;
      return id;
    }
  }
  const id = freshUuidv7(now);
  const record = scope?.record;
  if (record) (record.ids[model] ??= []).push(id);
  return id;
}

/** uuidv7() for a row of `model` (recorded and replayed under it). */
export const modelUuidv7 = (model: string): string => uuidv7(Date.now(), model);

/** A UUIDv7 outside any record: the id of a journal entry itself. */
export function freshUuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
