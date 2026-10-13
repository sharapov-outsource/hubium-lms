import { listModules } from '@hubium/core';
import { BASE_LOCALE, locales } from '@hubium/i18n';
import { createTranslator, packReport } from '@hubium/i18n/packs';
import { describe, expect, it } from 'vitest';
import './server';
import { moduleUIKeys } from './ui';

describe('module registries', () => {
  it('every server module has a UI and vice versa', () => {
    expect(moduleUIKeys.sort()).toEqual(
      listModules()
        .map((m) => m.key)
        .sort(),
    );
  });
  it('every module has a name and a description in every language', () => {
    const t = createTranslator(BASE_LOCALE);
    for (const m of listModules()) {
      for (const field of ['name', 'description']) {
        const key = `mod.${m.key}.${field}`;
        expect(t(key), key).not.toBe(key);
        for (const l of locales) expect(packReport(l).missing, `${l}: ${key}`).not.toContain(key);
      }
    }
  });
});
