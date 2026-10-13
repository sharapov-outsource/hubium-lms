import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor } from '../context.ts';

// While someone is logged in as another user, every event they cause records the real
// person too. Entry points (operations, module actions, server actions) open the scope
// once, so the many logEvent calls below them need not pass it along.

const scope = new AsyncLocalStorage<{ realActorId: string | null }>();

export function withActorScope<T>(actor: Actor, fn: () => T): T {
  const realActorId = actor.kind === 'user' ? (actor.realUserId ?? null) : null;
  return scope.run({ realActorId }, fn);
}

/** The person behind the current request when it runs as someone else; null otherwise. */
export function currentRealActorId(): string | null {
  return scope.getStore()?.realActorId ?? null;
}
