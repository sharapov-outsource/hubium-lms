'use server';

import { saveLdapServer, startLdapSync, testLdapConnection } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, MAP_PREFIX, mappingFromForm, runAction } from '../action';
import { getContext } from '../session';

/** The form's fields for the mapping's errors. */
const MAPPING_FIELDS = {
  'mapping.email': 'mapEmail',
  'mapping.firstName': 'mapFirstName',
  'mapping.lastName': 'mapLastName',
  'mapping.fields.': MAP_PREFIX,
};

/** Administration → LDAP. */
export async function saveLdapAction(fd: FormData) {
  return runAction(
    async () => {
      const v = formToObject(fd);
      const fields = mappingFromForm(v);
      const r = await saveLdapServer.run(await getContext(), {
        enabled: fd.get('enabled') === 'on',
        url: v.url ?? '',
        startTls: fd.get('startTls') === 'on',
        caCertificate: v.caCertificate,
        bindDn: v.bindDn ?? '',
        bindPassword: v.bindPassword || undefined,
        baseDn: v.baseDn ?? '',
        userFilter: v.userFilter ?? '',
        loginAttribute: v.loginAttribute ?? '',
        idAttribute: v.idAttribute ?? '',
        mapping: {
          email: v.mapEmail || 'mail',
          firstName: v.mapFirstName || 'givenName',
          lastName: v.mapLastName || 'sn',
          fields,
        },
        autoCreate: fd.get('autoCreate') === 'on',
        linkByEmail: fd.get('linkByEmail') === 'on',
        suspendMissing: fd.get('suspendMissing') === 'on',
      });
      revalidatePath('/admin/ldap');
      return r;
    },
    { fields: MAPPING_FIELDS },
  );
}

export async function testLdapAction(login: string) {
  return runAction(async () => testLdapConnection(await getContext(), login));
}

export async function syncLdapAction() {
  return runAction(async () => startLdapSync.run(await getContext(), {}));
}
