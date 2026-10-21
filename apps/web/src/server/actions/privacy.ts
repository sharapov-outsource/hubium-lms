'use server';

import { acceptPolicies, localizedFromForm, publishPolicyVersion, savePolicy } from '@hubium/core';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { getContext } from '../session';

export async function acceptPoliciesAction(versionIds: string[]) {
  return runAction(async () => acceptPolicies.run(await getContext(), { versionIds }), {
    duringGate: true,
  });
}

export async function savePolicyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await savePolicy.run(await getContext(), {
      id: v.id || undefined,
      key: v.key,
      name: localizedFromForm(v, 'name'),
    });
    revalidatePath('/admin/policies');
    return r;
  });
}

export async function publishPolicyAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await publishPolicyVersion.run(await getContext(), {
      policyId: v.policyId,
      content: localizedFromForm(v, 'content'),
      mandatory: fd.get('mandatory') === 'on',
    });
    revalidatePath('/admin/policies');
    return r;
  });
}
