import type { Db } from '@hubium/db';
import { log } from '@hubium/log';
import { ZodError } from 'zod';
import { AppError } from '../errors.ts';
import { authenticateNode } from './auth.ts';
import { nodeCertificates } from './certs.ts';
import { nodeFileGet, nodeFileList, nodeFilePut } from './files-api.ts';
import { heartbeat, receiveTouches, registerNode, renewSlot } from './hub.ts';
import { replayBatch } from './replay.ts';
import { currentLsn } from './replication.ts';
import { nodeStream } from './stream.ts';

// The node API, /api/node/<what>: what the agents of local nodes call. Every call but the
// registration carries the node's token (auth.ts).

const logger = log('nodes');

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function handleNodeApi(db: Db, req: Request, path: string[]): Promise<Response> {
  const what = path.join('/');
  try {
    if (what === 'register' && req.method === 'POST')
      return json(await registerNode(db, await req.json()));
    const node = await authenticateNode(db, req.headers.get('authorization'));
    if (!node) return json({ error: 'This node is not known or was revoked' }, 401);
    switch (`${req.method} ${what}`) {
      case 'POST heartbeat':
        return json(await heartbeat(db, node, await req.json()));
      case 'GET lsn':
        return json({ lsn: await currentLsn(db) });
      case 'GET stream':
        return nodeStream(db, req.signal);
      case 'POST touch':
        return json(await receiveTouches(db, node, await req.json()));
      case 'POST slot':
        return json(await renewSlot(db, node));
      case 'GET cert': {
        const certs = await nodeCertificates();
        return certs ? json(certs) : json({ error: 'The cloud hands out no certificates' }, 404);
      }
      case 'GET files/get':
        return await nodeFileGet(new URL(req.url));
      case 'GET files/list':
        return json(await nodeFileList(new URL(req.url)));
      case 'PUT files/put':
        return json(await nodeFilePut(node, new URL(req.url), req));
      case 'POST replay': {
        const r = await replayBatch(db, node, await req.json());
        return r === 'busy'
          ? json({ error: 'Another node is syncing: try again shortly' }, 409)
          : json(r);
      }
    }
    return json({ error: `No such call: ${req.method} ${what}` }, 404);
  } catch (e) {
    if (e instanceof ZodError) return json({ error: 'Bad request', issues: e.issues }, 400);
    if (e instanceof SyntaxError) return json({ error: 'Bad JSON' }, 400);
    if (e instanceof AppError) return json({ error: e.message }, e.status);
    logger.error({ err: e, call: what }, 'node API call failed');
    return json({ error: 'Internal error' }, 500);
  }
}
