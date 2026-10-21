import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../context.ts';

// While someone is logged in as another user, every event they cause records the real
// person too; an action that came through a local node records the node. Entry points
// (operations, module actions, server actions) open the scope once, so the many logEvent
// calls below them need not pass it along.

interface ActorScope {
  realActorId: string | null;
  nodeId: string | null;
}

// one store in the process, whichever copy of this module a bundle loaded
const shared = globalThis as unknown as { hubiumActorScope?: AsyncLocalStorage<ActorScope> };
const scope = (shared.hubiumActorScope ??= new AsyncLocalStorage<ActorScope>());

export function withActorScope<T>(actor: Actor, fn: () => T, nodeId?: string | null): T {
  const realActorId = actor.kind === 'user' ? (actor.realUserId ?? null) : null;
  return scope.run({ realActorId, nodeId: nodeId ?? scope.getStore()?.nodeId ?? null }, fn);
}

/** The local node the current action came through or ran on; null in the cloud itself. */
export function currentNodeId(): string | null {
  return scope.getStore()?.nodeId ?? null;
}

/** The person behind the current request when it runs as someone else; null otherwise. */
export function currentRealActorId(): string | null {
  return scope.getStore()?.realActorId ?? null;
}
