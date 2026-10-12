import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { useTestDb } from '../../test/helpers.ts';
import { ValidationError } from '../errors.ts';
import {
  appendUploadChunk,
  consumeUpload,
  createUpload,
  UPLOAD_MAX_BYTES,
  UPLOAD_PENDING_MAX_COUNT,
} from './uploads.ts';

describe('resumable uploads', () => {
  const t = useTestDb();

  it('a retried chunk racing the original is written once', async () => {
    const u = await t.db.user.findFirstOrThrow({ where: { username: 'student1' } });
    const data = Buffer.from('0123456789');
    const up = await createUpload(t.db, u.id, { name: 'x.txt', size: data.length });
    const results = await Promise.all([
      appendUploadChunk(t.db, u.id, up.id, 0, data.subarray(0, 5)),
      appendUploadChunk(t.db, u.id, up.id, 0, data.subarray(0, 5)),
    ]);
    expect(results.filter((r) => !r.conflict)).toHaveLength(1);
    expect(await appendUploadChunk(t.db, u.id, up.id, 5, data.subarray(5))).toEqual({
      received: 10,
    });
    const body = await consumeUpload(t.db, u.id, up.id, (f) => readFile(f.path));
    expect(body.toString()).toBe('0123456789');
  });

  it('limits unfinished uploads per user', async () => {
    const u = await t.db.user.findFirstOrThrow({ where: { username: 'student2' } });
    await createUpload(t.db, u.id, { name: 'big.bin', size: UPLOAD_MAX_BYTES });
    await createUpload(t.db, u.id, { name: 'big2.bin', size: UPLOAD_MAX_BYTES });
    await expect(createUpload(t.db, u.id, { name: 'more.bin', size: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const v = await t.db.user.findFirstOrThrow({ where: { username: 'student3' } });
    for (let i = 0; i < UPLOAD_PENDING_MAX_COUNT; i++)
      await createUpload(t.db, v.id, { name: `${i}.txt`, size: 1 });
    await expect(createUpload(t.db, v.id, { name: 'x.txt', size: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
