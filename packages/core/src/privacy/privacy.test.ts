import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { createApiToken } from '../api-tokens/tokens.ts';
import { openDirectConversation, sendMessage } from '../messaging/messaging.ts';
import { runModuleAction } from '../modules/actions.ts';
import { deleteUser } from '../users/users.ts';
import {
  acceptPolicies,
  exportUserData,
  pendingPolicies,
  publishPolicyVersion,
  savePolicy,
} from './privacy.ts';

describe('privacy', () => {
  const t = useTestDb();

  it('exports a user’s data, including module data, only to them or admins', async () => {
    const f = await courseFixture(t.db, 'PRIV1');
    const forum = await f.addActivity('forum', 'Обсуждение', { type: 'general' });
    const assign = await f.addActivity('assign', 'Эссе', { gradeMax: 10, onlineText: true });
    const s1 = await ctxFor(t.db, f.users.student1!);
    await runModuleAction(s1, forum.id, 'startDiscussion', {
      title: 'Привет',
      message: '<p>Мой пост</p>',
    });
    await runModuleAction(s1, assign.id, 'saveSubmission', { text: '<p>Моё эссе</p>' });
    const conv = await openDirectConversation.run(s1, { userId: f.users.student2! });
    await sendMessage.run(s1, { conversationId: conv.id, body: 'Секретное сообщение' });

    const data = await exportUserData(s1, f.users.student1!);
    expect(data.user).toMatchObject({ id: f.users.student1 });
    expect(data.messages.map((m: { body: string }) => m.body)).toContain('Секретное сообщение');
    expect(JSON.stringify(data.modules.forum)).toContain('Мой пост');
    expect(JSON.stringify(data.modules.assign)).toContain('Моё эссе');
    expect(data.enrolments.length).toBeGreaterThan(0);

    const s2 = await ctxFor(t.db, f.users.student2!);
    await expect(exportUserData(s2, f.users.student1!)).rejects.toThrow();
    const admin = await ctxFor(t.db, 'admin@test.local');
    await expect(exportUserData(admin, f.users.student1!)).resolves.toHaveProperty('user');
  });

  it('erases personal content when a user is deleted', async () => {
    const f = await courseFixture(t.db, 'PRIV2');
    const forum = await f.addActivity('forum', 'Форум', { type: 'general' });
    const assign = await f.addActivity('assign', 'Работа', { gradeMax: 10, onlineText: true });
    const victim = f.users.student3!;
    const s3 = await ctxFor(t.db, victim);
    await runModuleAction(s3, forum.id, 'startDiscussion', {
      title: 'Тема',
      message: '<p>Личное</p>',
    });
    await runModuleAction(s3, assign.id, 'saveSubmission', { text: '<p>Текст работы</p>' });
    const conv = await openDirectConversation.run(s3, { userId: f.users.student1! });
    await sendMessage.run(s3, { conversationId: conv.id, body: 'Удалите меня' });
    await createApiToken(s3, { name: 'x', scopes: ['read'] });

    const admin = await ctxFor(t.db, 'admin@test.local');
    await deleteUser.run(admin, { id: victim });

    const u = await t.db.user.findUniqueOrThrow({ where: { id: victim } });
    expect(u).toMatchObject({ status: 'DELETED', username: null });
    expect(u.email).toMatch(/@users\.invalid$/);
    const posts = await t.db.forumPost.findMany({ where: { authorId: victim } });
    expect(posts.every((p) => p.contentHtml === '' && p.deletedAt)).toBe(true);
    const subs = await t.db.assignSubmission.findMany({ where: { userId: victim } });
    expect(subs.every((s) => s.onlineText === '')).toBe(true);
    const msgs = await t.db.message.findMany({ where: { senderId: victim } });
    expect(msgs.every((m) => m.body === '' && m.deletedAt)).toBe(true);
    expect(await t.db.apiToken.count({ where: { userId: victim } })).toBe(0);
  });

  it('requires accepting new mandatory policy versions', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await savePolicy.run(admin, {
      key: 'privacy',
      name: { ru: 'Политика конфиденциальности', en: 'Privacy policy' },
    });
    await publishPolicyVersion.run(admin, { policyId: id, content: { ru: 'Версия 1', en: 'v1' } });
    const teacher = await t.db.user.findFirstOrThrow({ where: { username: 'teacher' } });
    const pending = await pendingPolicies(t.db, teacher.id);
    expect(pending.map((p) => p.content.ru)).toEqual(['Версия 1']);
    const ctx = await ctxFor(t.db, teacher.id);
    await expect(acceptPolicies(ctx, [])).rejects.toThrow();
    await acceptPolicies(
      ctx,
      pending.map((p) => p.versionId),
    );
    expect(await pendingPolicies(t.db, teacher.id)).toEqual([]);
    // a new version asks again; optional ones never block
    await publishPolicyVersion.run(admin, { policyId: id, content: { ru: 'Версия 2', en: 'v2' } });
    expect((await pendingPolicies(t.db, teacher.id)).map((p) => p.content.ru)).toEqual([
      'Версия 2',
    ]);
    await publishPolicyVersion.run(admin, {
      policyId: id,
      content: { ru: 'Версия 3', en: '' },
      mandatory: false,
    });
    expect(await pendingPolicies(t.db, teacher.id)).toEqual([]);
    const teacherCtx = await ctxFor(t.db, teacher.id);
    await expect(
      savePolicy.run(teacherCtx, { key: 'x', name: { ru: 'x', en: '' } }),
    ).rejects.toThrow();
  });
});
