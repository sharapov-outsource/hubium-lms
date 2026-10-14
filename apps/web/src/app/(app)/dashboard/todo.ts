import 'server-only';
import { collectTodo } from '@hubium/core';
import type { TodoItem } from '@hubium/module-sdk';
import { getContext } from '@/server/session';

/** The signed-in user's "to do" items from every enabled module. */
export async function getTodo(userId: string): Promise<TodoItem[]> {
  return collectTodo(await getContext(), userId);
}
