import { describe, expect, it } from 'vitest';
import { ChoiceSettings, choiceState } from './server.ts';

describe('choice settings', () => {
  it('reads options from the form as JSON and gives new ones ids', () => {
    const s = ChoiceSettings.parse({
      options: JSON.stringify([
        { id: 'kept', text: 'Да' },
        { text: 'Нет', limit: '3' },
      ]),
      allowUpdate: 'on',
    });
    expect(s.options[0]).toEqual({ id: 'kept', text: 'Да', limit: 0 });
    expect(s.options[1]).toMatchObject({ text: 'Нет', limit: 3 });
    expect(s.options[1]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ChoiceSettings.safeParse({ options: '[]' }).success).toBe(false);
    expect(
      ChoiceSettings.safeParse({
        options: [{ text: 'А' }],
        opensAt: '2026-10-02T00:00:00Z',
        closesAt: '2026-10-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('is open between its dates', () => {
    const s = ChoiceSettings.parse({
      options: [{ text: 'А' }],
      opensAt: '2026-10-01T00:00:00Z',
      closesAt: '2026-10-08T00:00:00Z',
    });
    expect(choiceState(s, new Date('2026-09-30T00:00:00Z'))).toBe('notOpen');
    expect(choiceState(s, new Date('2026-10-05T00:00:00Z'))).toBe('open');
    expect(choiceState(s, new Date('2026-10-08T00:00:00Z'))).toBe('closed');
  });
});
