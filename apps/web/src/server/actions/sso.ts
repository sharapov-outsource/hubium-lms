'use server';

import { deleteSsoProvider, saveSsoProvider } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

const MAP_PREFIX = 'map_field_';

/** Administration → Sign-in: an SSO provider's form. */
export async function saveSsoProviderAction(fd: FormData) {
  const res = await runAction(async () => {
    const v = formToObject(fd);
    const fields = Object.fromEntries(
      Object.entries(v)
        .filter(([k, a]) => k.startsWith(MAP_PREFIX) && a.trim())
        .map(([k, a]) => [k.slice(MAP_PREFIX.length), a.trim()]),
    );
    return saveSsoProvider.run(await getContext(), {
      id: v.id || undefined,
      providerId: v.providerId ?? '',
      name: v.name ?? '',
      protocol: v.protocol === 'saml' ? 'saml' : 'oidc',
      enabled: fd.get('enabled') === 'on',
      autoCreate: fd.get('autoCreate') === 'on',
      linkByEmail: fd.get('linkByEmail') === 'on',
      domain: v.domain ?? '',
      issuer: v.issuer,
      clientId: v.clientId,
      clientSecret: v.clientSecret,
      scopes: v.scopes,
      idpMetadataUrl: v.idpMetadataUrl,
      idpMetadataXml: v.idpMetadataXml,
      mapping: {
        email: v.mapEmail,
        firstName: v.mapFirstName,
        lastName: v.mapLastName,
        fields,
      },
    });
  });
  if (res.ok) {
    revalidatePath('/admin/sso');
    redirect(`/admin/sso/${res.data.id}?saved=1`);
  }
  return res;
}

export async function deleteSsoProviderAction(id: string) {
  const res = await runAction(async () => deleteSsoProvider.run(await getContext(), { id }));
  if (res.ok) redirect('/admin/sso?deleted=1');
  return res;
}
