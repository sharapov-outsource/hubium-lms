import { beforeAll, describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError } from '../errors.ts';
import { canReadFile } from '../files/files.ts';
import { createGroup, setGroupMembers } from '../groups/groups.ts';
import {
  canMessage,
  createGroupConversation,
  getConversation,
  listConversations,
  listMessages,
  markConversationRead,
  openDirectConversation,
  openGroupChat,
  searchMessageableUsers,
  sendMessage,
  sendTyping,
  setConversationState,
  setMessagePrivacy,
  setUserBlocked,
  unreadConversationCount,
} from './messaging.ts';

describe('messaging', () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof courseFixture>>;
  let dm: string;

  beforeAll(async () => {
    f = await courseFixture(t.db, 'MSG1');
  });

  const as = (id: string) => ctxFor(t.db, id);

  it('coursemates open a direct conversation once and exchange messages', async () => {
    const s1 = await as(f.users.student1!);
    const s2 = await as(f.users.student2!);
    dm = (await openDirectConversation.run(s1, { userId: f.users.student2 })).id;
    expect((await openDirectConversation.run(s2, { userId: f.users.student1 })).id).toBe(dm);
    await sendMessage.run(s1, { conversationId: dm, body: 'Привет!' });
    await sendMessage.run(s1, { conversationId: dm, body: 'Как дела?' });
    expect(await unreadConversationCount(t.db, f.users.student2!)).toBe(1);
    const list = await listConversations(t.db, f.users.student2!);
    expect(list[0]).toMatchObject({
      id: dm,
      kind: 'DIRECT',
      unread: 2,
      lastBody: 'Как дела?',
      otherUserId: f.users.student1,
    });
    const msgs = await listMessages(t.db, f.users.student2!, dm);
    expect(msgs.items.map((m) => m.body)).toEqual(['Привет!', 'Как дела?']);
    await markConversationRead.run(s2, { conversationId: dm });
    expect(await unreadConversationCount(t.db, f.users.student2!)).toBe(0);
  });

  it('notifies only once per burst of unread messages', async () => {
    const rows = await t.db.notification.findMany({
      where: { userId: f.users.student2, type: 'message.new' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inApp: false, emailState: 'DIGEST' });
    // after reading, the next message notifies again
    const s1 = await as(f.users.student1!);
    await sendMessage.run(s1, { conversationId: dm, body: 'Ещё' });
    expect(
      await t.db.notification.count({ where: { userId: f.users.student2, type: 'message.new' } }),
    ).toBe(2);
  });

  it('paginates with cursors', async () => {
    const page = await listMessages(t.db, f.users.student1!, dm, { limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.items.map((m) => m.body)).toEqual(['Как дела?', 'Ещё']);
    const older = await listMessages(t.db, f.users.student1!, dm, {
      before: page.items[0]!.id,
      limit: 2,
    });
    expect(older.items.map((m) => m.body)).toEqual(['Привет!']);
    const newer = await listMessages(t.db, f.users.student1!, dm, { after: older.items[0]!.id });
    expect(newer.items.map((m) => m.body)).toEqual(['Как дела?', 'Ещё']);
  });

  it('attachments are readable by members only', async () => {
    const s1 = await as(f.users.student1!);
    const { id } = await sendMessage.run(s1, {
      conversationId: dm,
      attachments: [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hi') }],
    });
    const msg = (await listMessages(t.db, f.users.student2!, dm)).items.find((m) => m.id === id);
    expect(msg?.attachments[0]?.name).toBe('notes.txt');
    const file = await t.db.file.findFirstOrThrow({ where: { itemId: id } });
    expect(await canReadFile(await as(f.users.student2!), file)).toBe(true);
    expect(await canReadFile(await as(f.users.student3!), file)).toBe(false);
  });

  it('rejects empty messages and strangers', async () => {
    const s1 = await as(f.users.student1!);
    await expect(sendMessage.run(s1, { conversationId: dm, body: '   ' })).rejects.toThrow();
    const s3 = await as(f.users.student3!);
    await expect(listMessages(t.db, f.users.student3!, dm)).rejects.toThrow();
    await expect(sendMessage.run(s3, { conversationId: dm, body: 'hi' })).rejects.toThrow();
  });

  it('privacy: coursemates by default, nobody, admins always', async () => {
    const outsider = await t.db.user.findFirstOrThrow({ where: { username: 'manager' } });
    expect(await canMessage(t.db, { id: outsider.id }, f.users.student2!)).toEqual({
      ok: false,
      reason: 'privacy',
    });
    const s3 = await as(f.users.student3!);
    await setMessagePrivacy.run(s3, { privacy: 'NOBODY' });
    const s1 = await as(f.users.student1!);
    await expect(openDirectConversation.run(s1, { userId: f.users.student3 })).rejects.toThrow(
      ForbiddenError,
    );
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(
      openDirectConversation.run(admin, { userId: f.users.student3 }),
    ).resolves.toBeTruthy();
    await setMessagePrivacy.run(s3, { privacy: 'ANYONE' });
    expect((await canMessage(t.db, { id: outsider.id }, f.users.student3!)).ok).toBe(true);
    const found = await searchMessageableUsers(await as(outsider.id), 'Иванов');
    expect(found.map((u) => u.id)).toContain(f.users.student3);
    // addresses are not shown to learners, so a piece of one finds nobody; the whole
    // address or login does
    const ids = async (q: string) =>
      (await searchMessageableUsers(await as(outsider.id), q)).map((u) => u.id);
    for (const piece of ['student3@hub', 'udent3', '@hubium.local'])
      expect(await ids(piece)).not.toContain(f.users.student3);
    expect(await ids('student3@hubium.local')).toContain(f.users.student3);
    expect(await ids('student3')).toContain(f.users.student3);
  });

  it('blocking stops delivery in both directions', async () => {
    const s2 = await as(f.users.student2!);
    await setUserBlocked.run(s2, { userId: f.users.student1, blocked: true });
    const s1 = await as(f.users.student1!);
    await expect(sendMessage.run(s1, { conversationId: dm, body: 'hey' })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(sendMessage.run(s2, { conversationId: dm, body: 'hey' })).rejects.toThrow(
      ForbiddenError,
    );
    expect((await getConversation(t.db, f.users.student1!, dm)).blocked).toBe(true);
    await setUserBlocked.run(s2, { userId: f.users.student1, blocked: false });
    await expect(sendMessage.run(s1, { conversationId: dm, body: 'ok' })).resolves.toBeTruthy();
  });

  it('group conversations and course group chats', async () => {
    const s1 = await as(f.users.student1!);
    const { id } = await createGroupConversation.run(s1, {
      name: 'Проект',
      userIds: [f.users.student2, f.users.student3],
    });
    expect((await getConversation(t.db, f.users.student3!, id)).members).toHaveLength(3);
    const s3 = await as(f.users.student3!);
    await setConversationState.run(s3, { conversationId: id, leave: true });
    await expect(listMessages(t.db, f.users.student3!, id)).rejects.toThrow();

    const sys = await ctxFor(t.db, 'system');
    const { id: groupId } = await createGroup.run(sys, { courseId: f.courseId, name: 'Группа A' });
    await setGroupMembers.run(sys, { groupId, add: [f.users.student1!, f.users.student2!] });
    const chat = await openGroupChat.run(s1, { groupId });
    expect(await openGroupChat.run(await as(f.users.student2!), { groupId })).toEqual(chat);
    await expect(openGroupChat.run(s3, { groupId })).rejects.toThrow(ForbiddenError);
    const teacherChat = await openGroupChat.run(await as(f.users.teacher!), { groupId });
    expect(teacherChat.id).toBe(chat.id);
    const conv = await getConversation(t.db, f.users.student1!, chat.id);
    expect(conv.members.map((m) => m.id).sort()).toEqual(
      [f.users.student1, f.users.student2, f.users.teacher].sort(),
    );
    await sendTyping(t.db, f.users.student1!, chat.id);
    await expect(sendTyping(t.db, f.users.student3!, chat.id)).rejects.toThrow();
  });
});
