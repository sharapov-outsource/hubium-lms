import { describe, expect, it } from 'vitest';
import { ForumSettings, forum, postVisible } from './server.ts';

describe('forum settings', () => {
  it('defaults and form coercion', () => {
    const s = ForumSettings.parse({ maxAttachments: '2', allowPrivateReplies: 'false' });
    expect(s).toMatchObject({
      type: 'general',
      subscription: 'optional',
      maxAttachments: 2,
      allowPrivateReplies: false,
      editMinutes: 30,
    });
    expect(ForumSettings.safeParse({ type: 'blog' }).success).toBe(false);
  });
  it('declares the post notification type', () => {
    expect(forum.notifications?.post?.email).toBe('IMMEDIATE');
  });
});

describe('postVisible', () => {
  const pub = { authorId: 'a', privateToUserId: null };
  const priv = { authorId: 't', privateToUserId: 's1' };
  it('public posts are visible to everyone', () => {
    expect(postVisible(pub, 'x', false)).toBe(true);
  });
  it('private replies: author, recipient and moderators', () => {
    expect(postVisible(priv, 't', false)).toBe(true);
    expect(postVisible(priv, 's1', false)).toBe(true);
    expect(postVisible(priv, 's2', false)).toBe(false);
    expect(postVisible(priv, 's2', true)).toBe(true);
  });
});
