import { WEBHOOK_EVENTS } from '@hubium/core/webhooks/events';
import { describe, expect, it } from 'vitest';
import { EVENT_GROUPS } from './event-groups';

describe('webhook event groups', () => {
  it('list every event the core sends, each once', () => {
    const listed = Object.values(EVENT_GROUPS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });
});
