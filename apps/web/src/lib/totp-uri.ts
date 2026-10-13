/**
 * The otpauth:// URI with `issuer` as the name authenticator apps show for the account (the
 * site name instead of the engine's). The secret and code checks do not depend on it.
 */
export function withIssuer(uri: string, issuer: string): string {
  const u = new URL(uri);
  if (u.protocol !== 'otpauth:' || !issuer.trim()) return uri;
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''));
  const account = label.includes(':') ? label.slice(label.indexOf(':') + 1) : label;
  // Spaces as %20, not "+": some authenticator apps show a literal plus.
  const query = [...u.searchParams]
    .filter(([k]) => k !== 'issuer')
    .concat([['issuer', issuer]])
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `otpauth://${u.host}/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${query}`;
}
