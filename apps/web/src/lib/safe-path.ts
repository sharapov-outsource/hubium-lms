/**
 * A same-site path for redirects: "/x…" only. Browsers read "//host" and "/\host" (and
 * the same with tabs or newlines in between) as another site, so those are refused.
 */
export function isSafePath(p: string | null | undefined): p is string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  return !!p && p.startsWith('/') && !/^\/[\\/\s]|[\\\u0000-\u001f\u007f]/.test(p);
}

export const safePath = (p: string | null | undefined, fallback: string) =>
  isSafePath(p) ? p : fallback;
