'use server';

import {
  checkCertificateBackground,
  deleteCertificate,
  issueCertificate,
  revokeCertificateIssue,
  saveCertificate,
  setCertificateBackground,
  setCertificateStatus,
  ValidationError,
} from '@hubium/core';
import { msg } from '@hubium/module-sdk';
import { revalidatePath } from 'next/cache';
import { formToObject, runAction } from '../action';
import { formFile } from '../form-files';
import { getContext } from '../session';

const pathOf = (courseId: string | undefined) => `/course/${courseId}/certificates`;

/** Saves a certificate template, with its background when one was chosen or removed. */
export async function saveCertificateAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const ctx = await getContext();
    let fields: unknown = [];
    try {
      fields = JSON.parse(v.fields ?? '[]');
    } catch {
      throw new ValidationError({ fields: [msg('errors.certificates.invalidFields')] });
    }
    // the picture is checked first: a refused one must not leave a new certificate behind
    const file = await formFile(fd, 'background');
    const data =
      file instanceof File && file.size ? new Uint8Array(await file.arrayBuffer()) : null;
    if (data) checkCertificateBackground(data);
    const r = await saveCertificate.run(ctx, {
      id: v.id || undefined,
      courseId: v.courseId || undefined,
      name: v.name ?? '',
      orientation: v.orientation === 'portrait' ? 'portrait' : 'landscape',
      fields,
      onCompletion: v.onCompletion === 'on',
    });
    if (data && file instanceof File)
      await setCertificateBackground.run(ctx, { id: r.id, name: file.name, data });
    else if (v.removeBackground === 'on')
      await setCertificateBackground.run(ctx, { id: r.id, data: null });
    revalidatePath(pathOf(v.courseId), 'layout');
    return r;
  });
}

export async function setCertificateStatusAction(
  courseId: string,
  id: string,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
) {
  return runAction(async () => {
    await setCertificateStatus.run(await getContext(), { id, status });
    revalidatePath(pathOf(courseId), 'layout');
    return null;
  });
}

export async function deleteCertificateAction(courseId: string, id: string) {
  return runAction(async () => {
    await deleteCertificate.run(await getContext(), { id });
    revalidatePath(pathOf(courseId));
    return null;
  });
}

export async function issueCertificateAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await issueCertificate.run(await getContext(), {
      certificateId: v.certificateId ?? '',
      userId: v.userId ?? '',
    });
    revalidatePath(pathOf(v.courseId), 'layout');
    return r;
  });
}

export async function revokeCertificateAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    await revokeCertificateIssue.run(await getContext(), {
      issueId: v.issueId ?? '',
      reason: v.reason ?? '',
    });
    revalidatePath(pathOf(v.courseId), 'layout');
    return null;
  });
}
