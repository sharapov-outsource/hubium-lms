// Accent palette generator. The admin picks one brand colour; we derive the light- and
// dark-theme accents in OKLCH and nudge lightness until text contrast reaches WCAG AA (4.5:1).

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid hex colour: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}

function oklchToLinear({ l: L, c: C, h: H }: Oklch): [number, number, number] {
  const hr = (H * Math.PI) / 180;
  const A = C * Math.cos(hr);
  const B = C * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Converts to sRGB, reducing chroma until the colour is inside the gamut. */
export function oklchToRgb(c: Oklch): Rgb {
  let chroma = c.c;
  for (let i = 0; i < 40; i++) {
    const lin = oklchToLinear({ ...c, c: chroma });
    if (lin.every((v) => v >= -0.0001 && v <= 1.0001)) {
      return { r: fromLinear(lin[0]), g: fromLinear(lin[1]), b: fromLinear(lin[2]) };
    }
    chroma *= 0.9;
  }
  const lin = oklchToLinear({ ...c, c: 0 });
  return { r: fromLinear(lin[0]), g: fromLinear(lin[1]), b: fromLinear(lin[2]) };
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const LIGHT_BG: Rgb = hexToRgb('#ffffff');
const LIGHT_SURFACE: Rgb = hexToRgb('#f7f7f8');
const DARK_BG: Rgb = hexToRgb('#111318');

export interface AccentPalette {
  light: { accent: string; accentForeground: string; accentSoft: string; ring: string };
  dark: { accent: string; accentForeground: string; accentSoft: string; ring: string };
  /** True when the input colour had to be adjusted to reach 4.5:1. */
  adjusted: boolean;
  /** Contrast of the original colour against white text. */
  originalContrast: number;
}

// Small margin above WCAG AA so rounding in browsers never dips below 4.5.
const MIN_CONTRAST = 4.6;

/** Darkens (dir=-1) or lightens (dir=1) until `fg` on the colour reaches the target. */
function adjustLightness(base: Oklch, target: (rgb: Rgb) => number, dir: -1 | 1): Oklch {
  let c = { ...base };
  for (let i = 0; i < 100 && target(oklchToRgb(c)) < MIN_CONTRAST; i++) {
    c = { ...c, l: Math.min(1, Math.max(0, c.l + dir * 0.01)) };
  }
  return c;
}

export function generateAccentPalette(hex: string): AccentPalette {
  const rgb = hexToRgb(hex);
  const base = rgbToOklch(rgb);
  const originalContrast = contrastRatio(rgb, WHITE);

  // Light theme: white text on the accent; the accent is also text on white, on the page
  // surface and on its own soft tint (active nav item, badges).
  const lightSoft = oklchToRgb({ l: 0.96, c: Math.min(base.c, 0.04), h: base.h });
  const lightAccent = adjustLightness(
    base,
    (c) =>
      Math.min(
        contrastRatio(c, WHITE),
        contrastRatio(c, LIGHT_BG),
        contrastRatio(c, LIGHT_SURFACE),
        contrastRatio(c, lightSoft),
      ),
    -1,
  );
  // Dark theme: accent is lighter so it reads on the dark background; text on it is near-black.
  const darkStart: Oklch = { ...base, l: Math.max(base.l, 0.72) };
  const darkSoft = oklchToRgb({ l: 0.27, c: Math.min(base.c, 0.06), h: base.h });
  const darkAccent = adjustLightness(
    darkStart,
    (c) => Math.min(contrastRatio(c, DARK_BG), contrastRatio(c, darkSoft)),
    1,
  );
  const darkFg = rgbToHex(oklchToRgb({ l: 0.18, c: Math.min(base.c, 0.03), h: base.h }));

  const lightHex = rgbToHex(oklchToRgb(lightAccent));
  const darkHex = rgbToHex(oklchToRgb(darkAccent));
  return {
    light: {
      accent: lightHex,
      accentForeground: '#ffffff',
      accentSoft: rgbToHex(lightSoft),
      ring: lightHex,
    },
    dark: {
      accent: darkHex,
      accentForeground: darkFg,
      accentSoft: rgbToHex(darkSoft),
      ring: darkHex,
    },
    adjusted: lightHex.toLowerCase() !== hex.toLowerCase(),
    originalContrast,
  };
}

/** CSS that overrides the accent tokens; injected into <head> by the web app. */
export function paletteCss(p: AccentPalette): string {
  const vars = (v: AccentPalette['light']) =>
    `--accent:${v.accent};--accent-foreground:${v.accentForeground};--accent-soft:${v.accentSoft};--ring:${v.ring};`;
  return `:root{${vars(p.light)}}.dark{${vars(p.dark)}}`;
}
