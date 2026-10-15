import type { Prisma } from '@hubium/db';
import { publishInvalidation } from '../cache-bus.ts';

/** Extra fields carry profile fields under this prefix through Better Auth's mapping. */
export const SSO_FIELD_PREFIX = 'hubium_field_';

type Mapping = { fields?: Record<string, string> } & Record<string, unknown>;

const moveKey = <T>(o: Record<string, T>, from: string, to: string | null) =>
  Object.fromEntries(
    Object.entries(o).flatMap(([k, v]) => (k !== from ? [[k, v]] : to ? [[to, v]] : [])),
  );

/**
 * SSO providers and the LDAP directory fill custom profile fields named by their short names:
 * a renamed field (`to`) keeps being filled, a deleted one (`to` null) is dropped from them.
 * An SSO provider has the mapping twice, as entered and in Better Auth's configuration.
 */
export async function moveFieldMappings(
  tx: Prisma.TransactionClient,
  from: string,
  to: string | null,
): Promise<void> {
  const providers = await tx.ssoProvider.findMany({
    select: { id: true, mapping: true, oidcConfig: true, samlConfig: true },
  });
  let changed = false;
  for (const p of providers) {
    const mapping = (p.mapping ?? {}) as Mapping;
    if (!mapping.fields || !(from in mapping.fields)) continue;
    const config = (raw: string | null) => {
      if (!raw) return raw;
      const c = JSON.parse(raw) as { mapping?: { extraFields?: Record<string, string> } };
      if (c.mapping?.extraFields)
        c.mapping.extraFields = moveKey(
          c.mapping.extraFields,
          SSO_FIELD_PREFIX + from,
          to && SSO_FIELD_PREFIX + to,
        );
      return JSON.stringify(c);
    };
    await tx.ssoProvider.update({
      where: { id: p.id },
      data: {
        mapping: { ...mapping, fields: moveKey(mapping.fields, from, to) },
        oidcConfig: config(p.oidcConfig),
        samlConfig: config(p.samlConfig),
      },
    });
    changed = true;
  }
  if (changed) await publishInvalidation(tx, 'auth');

  const ldap = await tx.ldapServer.findUnique({ where: { id: 'default' } });
  const lm = (ldap?.mapping ?? {}) as Mapping;
  if (ldap && lm.fields && from in lm.fields)
    await tx.ldapServer.update({
      where: { id: 'default' },
      data: { mapping: { ...lm, fields: moveKey(lm.fields, from, to) } },
    });
}
