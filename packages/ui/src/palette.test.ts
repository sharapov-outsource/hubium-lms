import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  generateAccentPalette,
  hexToRgb,
  oklchToRgb,
  rgbToHex,
  rgbToOklch,
} from './palette.ts';

describe('colour conversions', () => {
  it('round-trips hex through OKLCH', () => {
    for (const hex of ['#4f46e5', '#000000', '#ffffff', '#ff0000', '#10b981', '#7c3aed']) {
      expect(rgbToHex(oklchToRgb(rgbToOklch(hexToRgb(hex))))).toBe(hex);
    }
  });
  it('computes WCAG contrast', () => {
    expect(contrastRatio(hexToRgb('#000000'), hexToRgb('#ffffff'))).toBeCloseTo(21, 1);
    expect(contrastRatio(hexToRgb('#777777'), hexToRgb('#ffffff'))).toBeCloseTo(4.48, 1);
  });
  it('rejects invalid hex', () => {
    expect(() => hexToRgb('red')).toThrow();
  });
});

describe('generateAccentPalette', () => {
  it('keeps an accessible colour as is', () => {
    const p = generateAccentPalette('#3730a3');
    expect(p.adjusted).toBe(false);
    expect(p.light.accent).toBe('#3730a3');
  });
  it('darkens a low-contrast colour to reach 4.5:1 with white text', () => {
    const p = generateAccentPalette('#facc15');
    expect(p.adjusted).toBe(true);
    expect(p.originalContrast).toBeLessThan(4.5);
    expect(contrastRatio(hexToRgb(p.light.accent), hexToRgb('#ffffff'))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
  it('dark theme accent is readable on the dark background', () => {
    for (const hex of ['#1e3a8a', '#4f46e5', '#facc15', '#000000', '#dc2626']) {
      const p = generateAccentPalette(hex);
      expect(contrastRatio(hexToRgb(p.dark.accent), hexToRgb('#111318'))).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrastRatio(hexToRgb(p.dark.accent), hexToRgb(p.dark.accentForeground)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('light theme accent passes on white, surface and its soft tint', () => {
    for (const hex of ['#ffffff', '#a3e635', '#22d3ee', '#f472b6', '#facc15', '#4f46e5']) {
      const p = generateAccentPalette(hex);
      const a = hexToRgb(p.light.accent);
      expect(contrastRatio(a, hexToRgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(a, hexToRgb('#f7f7f8'))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(a, hexToRgb(p.light.accentSoft))).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(hexToRgb(p.dark.accent), hexToRgb(p.dark.accentSoft)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
