'use server';

import {
  createGroupConversation,
  deleteMessage,
  getConversation,
  listConversations,
  listMessages,
  listNotifications,
  markConversationRead,
  markNotificationsRead,
  openDirectConversation,
  openGroupChat,
  searchMessageableUsers,
  sendMessage,
  setConversationState,
  setMessagePrivacy,
  setUserBlocked,
  unreadConversationCount,
  unreadNotificationCount,
  updateNotificationPreferences,
} from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { runAction } from '../action';
import { db } from '../db';
import { getContext, requireUser } from '../session';

// ── counters and notifications ────────────────────────────────────────────────

export async function getCommsCountsAction() {
  const user = await requireUser();
  const [notifications, messages] = await Promise.all([
    unreadNotificationCount(db, user.id),
    unreadConversationCount(db, user.id),
  ]);
  return { notifications, messages };
}

export async function recentNotificationsAction(
  opts: { before?: string; unreadOnly?: boolean } = {},
) {
  const user = await requireUser();
  const page = await listNotifications(db, user.id, { ...opts, limit: 15 });
  return {
    hasMore: page.hasMore,
    items: page.items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      url: n.url,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
      actor: n.actor ? { name: n.actor.name, image: n.actor.image } : null,
    })),
  };
}

export async function markNotificationsReadAction(input: { ids?: string[]; all?: boolean }) {
  return runAction(async () => {
    const r = await markNotificationsRead.run(await getContext(), input);
    revalidatePath('/notifications');
    return r;
  });
}

export async function saveNotificationPrefsAction(fd: FormData) {
  return runAction(async () => {
    const types = fd.getAll('type').map(String);
    const prefs = types.map((type) => ({
      type,
      inApp: fd.get(`inApp:${type}`) === 'on',
      email: String(fd.get(`email:${type}`) ?? 'IMMEDIATE') as 'OFF' | 'IMMEDIATE' | 'DIGEST',
    }));
    await updateNotificationPreferences.run(await getContext(), {
      digestHour: fd.get('digestHour'),
      prefs,
    });
    revalidatePath('/settings/notifications');
    return null;
  });
}

// ── messaging ─────────────────────────────────────────────────────────────────

export interface ClientMessage {
  id: string;
  senderId: string | null;
  senderName: string | null;
  body: string;
  createdAt: string;
  deleted: boolean;
  attachments: { id: string; name: string; mimeType: string; size: number; url: string }[];
}

export async function conversationsAction(q?: string) {
  const user = await requireUser();
  const rows = await listConversations(db, user.id, { q });
  return rows.map((c) => ({
    ...c,
    lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : null,
  }));
}

export async function messagesAction(
  conversationId: string,
  opts: { before?: string; after?: string } = {},
): Promise<{ items: ClientMessage[]; hasMore: boolean }> {
  const user = await requireUser();
  const page = await listMessages(db, user.id, conversationId, { ...opts, limit: 30 });
  return {
    hasMore: page.hasMore,
    items: page.items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
  };
}

export async function conversationInfoAction(conversationId: string) {
  const user = await requireUser();
  const c = await getConversation(db, user.id, conversationId);
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    groupId: c.groupId,
    muted: !!c.mutedUntil && c.mutedUntil > new Date(),
    blocked: c.blocked,
    iBlocked: c.iBlocked,
    other: c.other ? { id: c.other.id, name: c.other.name, image: c.other.image } : null,
    members: c.members.map((m) => ({ id: m.id, name: m.name, image: m.image })),
  };
}

export async function sendMessageAction(fd: FormData) {
  return runAction(async () => {
    const files = await Promise.all(
      fd
        .getAll('files')
        .filter((f): f is File => f instanceof File && f.size > 0)
        .map(async (f) => ({
          name: f.name,
          mimeType: f.type || 'application/octet-stream',
          data: Buffer.from(await f.arrayBuffer()),
        })),
    );
    return sendMessage.run(await getContext(), {
      conversationId: String(fd.get('conversationId') ?? ''),
      body: String(fd.get('body') ?? ''),
      attachments: files,
    });
  });
}

export async function markConversationReadAction(conversationId: string) {
  return runAction(async () => markConversationRead.run(await getContext(), { conversationId }));
}

export async function deleteMessageAction(id: string) {
  return runAction(async () => deleteMessage.run(await getContext(), { id }));
}

export async function searchPeopleAction(q: string) {
  return searchMessageableUsers(await getContext(), q);
}

export async function openDirectAction(userId: string) {
  return runAction(async () => openDirectConversation.run(await getContext(), { userId }));
}

export async function openGroupChatAction(groupId: string) {
  return runAction(async () => openGroupChat.run(await getContext(), { groupId }));
}

export async function createGroupConversationAction(input: { name: string; userIds: string[] }) {
  return runAction(async () => createGroupConversation.run(await getContext(), input));
}

export async function conversationStateAction(input: {
  conversationId: string;
  muted?: boolean;
  archived?: boolean;
  leave?: boolean;
}) {
  return runAction(async () => setConversationState.run(await getContext(), input));
}

export async function blockUserAction(userId: string, blocked: boolean) {
  return runAction(async () => {
    const r = await setUserBlocked.run(await getContext(), { userId, blocked });
    revalidatePath('/settings/messages');
    return r;
  });
}

export async function setMessagePrivacyAction(fd: FormData) {
  return runAction(async () => {
    await setMessagePrivacy.run(await getContext(), { privacy: fd.get('privacy') });
    revalidatePath('/settings/messages');
    return null;
  });
}
