import { listModules } from '@hubium/core';
import { describe, expect, it } from 'vitest';
import './server';
import { moduleMessages } from './messages';
import { moduleUIKeys } from './ui';

describe('module registries', () => {
  it('every server module has a UI and vice versa', () => {
    expect(moduleUIKeys.sort()).toEqual(
      listModules()
        .map((m) => m.key)
        .sort(),
    );
  });
  it('every module has ru/en name and description', () => {
    for (const m of listModules()) {
      for (const l of ['ru', 'en'] as const) {
        const msgs = (moduleMessages[l] as Record<string, { name?: string; description?: string }>)[
          m.key
        ];
        expect(msgs?.name, `${l}.${m.key}.name`).toBeTruthy();
        expect(msgs?.description, `${l}.${m.key}.description`).toBeTruthy();
      }
    }
  });
});
