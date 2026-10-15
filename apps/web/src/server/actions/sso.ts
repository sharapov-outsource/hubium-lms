'use server';

import { deleteSsoProvider, saveSsoProvider } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { formToObject, MAP_PREFIX, mappingFromForm, runAction } from '../action';
import { getContext } from '../session';

/** The form's fields for the mapping's errors. */
const MAPPING_FIELDS = {
  'mapping.email': 'mapEmail',
  'mapping.firstName': 'mapFirstName',
  'mapping.lastName': 'mapLastName',
  'mapping.fields.': MAP_PREFIX,
};

/** Administration → Sign-in: an SSO provider's form. */
export async function saveSsoProviderAction(fd: FormData) {
  const res = await runAction(
    async () => {
      const v = formToObject(fd);
      const fields = mappingFromForm(v);
      return saveSsoProvider.run(await getContext(), {
        id: v.id || undefined,
        providerId: v.providerId ?? '',
        name: v.name ?? '',
        protocol: v.protocol === 'saml' || v.protocol === 'oauth2' ? v.protocol : 'oidc',
        enabled: fd.get('enabled') === 'on',
        autoCreate: fd.get('autoCreate') === 'on',
        linkByEmail: fd.get('linkByEmail') === 'on',
        domain: v.domain ?? '',
        issuer: v.issuer,
        clientId: v.clientId,
        clientSecret: v.clientSecret,
        scopes: v.scopes,
        authorizationUrl: v.authorizationUrl,
        tokenUrl: v.tokenUrl,
        userInfoUrl: v.userInfoUrl,
        idpMetadataUrl: v.idpMetadataUrl,
        idpMetadataXml: v.idpMetadataXml,
        mapping: {
          email: v.mapEmail,
          firstName: v.mapFirstName,
          lastName: v.mapLastName,
          fields,
        },
      });
    },
    { fields: MAPPING_FIELDS },
  );
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
