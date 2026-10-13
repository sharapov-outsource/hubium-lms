'use server';

import {
  assignSystemRole,
  bulkUploadUsers,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  ForbiddenError,
  getAllSettings,
  listProfileFields,
  logEvent,
  profileValuesFromForm,
  saveLanguageSettings,
  setRoleCapability,
  setRoleOverride,
  setSettings,
  setUserSuspended,
  siteLocale,
  updateRole,
  updateUser,
  userLocale,
  ValidationError,
  validateProfileValues,
} from '@hubium/core';
import { BRANDING_CONTEXT, storeFile } from '@hubium/core/files/files';
import { enqueue } from '@hubium/core/jobs/jobs';
import { renderActionEmail } from '@hubium/core/mail/mail';
import { SYSTEM_CONTEXT_ID } from '@hubium/db';
import { createTranslator } from '@hubium/i18n/packs';
import { generateAccentPalette } from '@hubium/ui/palette';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { formToObject, runAction } from '../action';
import { auth } from '../auth';
import { db } from '../db';
import { getContext, requireUser } from '../session';

const bool = (v: FormDataEntryValue | null) => v === 'on' || v === 'true' || v === '1';

/** Custom profile fields of the admin user form; required ones must be filled. */
async function profileFieldsFromForm(v: Record<string, string>) {
  const fields = await listProfileFields(db);
  return validateProfileValues(fields, profileValuesFromForm(fields, v), { requireAll: true });
}

export async function createUserAction(fd: FormData) {
  const res = await runAction(async () => {
    const ctx = await getContext();
    const v = formToObject(fd);
    return createUser.run(ctx, {
      ...v,
      isSiteAdmin: bool(fd.get('isSiteAdmin')),
      customFields: await profileFieldsFromForm(v),
    });
  });
  if (res.ok) redirect(`/admin/users/${res.data.id}?created=1`);
  return res;
}

export async function updateUserAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await getContext();
    const v = formToObject(fd);
    const r = await updateUser.run(ctx, {
      ...v,
      locale: v.locale || null,
      timezone: v.timezone || null,
      isSiteAdmin: ctx.perm.isSiteAdmin ? bool(fd.get('isSiteAdmin')) : undefined,
      customFields: await profileFieldsFromForm(v),
    });
    revalidatePath(`/admin/users/${r.id}`);
    return r;
  });
}

export async function setUserSuspendedAction(id: string, suspended: boolean) {
  return runAction(async () => {
    const r = await setUserSuspended.run(await getContext(), { id, suspended });
    revalidatePath(`/admin/users/${id}`);
    revalidatePath('/admin/users');
    return r;
  });
}

export async function deleteUserAction(id: string) {
  const res = await runAction(async () => deleteUser.run(await getContext(), { id }));
  if (res.ok) redirect('/admin/users?deleted=1');
  return res;
}

export async function assignSystemRoleAction(userId: string, roleId: string, assigned: boolean) {
  return runAction(async () => {
    const r = await assignSystemRole.run(await getContext(), { userId, roleId, assigned });
    revalidatePath(`/admin/users/${userId}`);
    return r;
  });
}

export async function uploadUsersAction(fd: FormData) {
  return runAction(async () => {
    const file = fd.get('file');
    if (!(file instanceof File) || file.size === 0)
      throw new ValidationError({ file: ['Choose a CSV file'] });
    const csv = Buffer.from(await file.arrayBuffer()).toString('utf8');
    const r = await bulkUploadUsers.run(await getContext(), { csv });
    revalidatePath('/admin/users');
    return r;
  });
}

// ── roles ─────────────────────────────────────────────────────────────────────

const LEVELS = ['SYSTEM', 'CATEGORY', 'COURSE', 'ACTIVITY'] as const;

export async function createRoleAction(fd: FormData) {
  const res = await runAction(async () => {
    const v = formToObject(fd);
    return createRole.run(await getContext(), {
      shortName: v.shortName,
      name: { ru: v.nameRu, en: v.nameEn },
      archetype: v.archetype,
      assignableLevels: LEVELS.filter((l) => fd.get(`level_${l}`)),
      copyFromRoleId: v.copyFromRoleId || undefined,
    });
  });
  if (res.ok) redirect(`/admin/roles/${res.data.id}`);
  return res;
}

export async function updateRoleAction(fd: FormData) {
  return runAction(async () => {
    const v = formToObject(fd);
    const r = await updateRole.run(await getContext(), {
      id: v.id,
      name: { ru: v.nameRu, en: v.nameEn },
      assignableLevels: LEVELS.filter((l) => fd.get(`level_${l}`)),
    });
    revalidatePath(`/admin/roles/${r.id}`);
    return r;
  });
}

export async function deleteRoleAction(id: string) {
  const res = await runAction(async () => deleteRole.run(await getContext(), { id }));
  if (res.ok) redirect('/admin/roles');
  return res;
}

export async function setRoleOverrideAction(
  contextId: string,
  roleId: string,
  capability: string,
  permission: 'ALLOW' | 'DENY' | 'PROHIBIT' | 'INHERIT',
) {
  return runAction(async () =>
    setRoleOverride.run(await getContext(), { contextId, roleId, capability, permission }),
  );
}

export async function setRoleCapabilityAction(
  roleId: string,
  capability: string,
  permission: 'ALLOW' | 'PROHIBIT' | 'INHERIT',
) {
  return runAction(async () =>
    setRoleCapability.run(await getContext(), { roleId, capability, permission }),
  );
}

// ── site settings ─────────────────────────────────────────────────────────────

async function requireConfig() {
  const ctx = await getContext();
  await ctx.perm.require('site:config');
  return ctx;
}

export async function saveSettingsAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireConfig();
    const section = String(fd.get('_section'));
    const v = formToObject(fd);
    const values: Record<string, unknown> = {};
    switch (section) {
      case 'general':
        Object.assign(values, {
          'site.name': v.siteName,
          'site.defaultTimezone': v.defaultTimezone,
          'course.creatorRole': v.creatorRole,
        });
        break;
      case 'registration':
        Object.assign(values, {
          'registration.enabled': bool(fd.get('enabled')),
          'registration.requireEmailVerification': bool(fd.get('requireEmailVerification')),
          'registration.consentText': v.consentText ?? '',
        });
        break;
      case 'authentication':
        Object.assign(values, {
          'auth.oauth.google': bool(fd.get('google')),
          'auth.oauth.yandex': bool(fd.get('yandex')),
          'auth.oauth.vk': bool(fd.get('vk')),
          'auth.require2faForAdmins': bool(fd.get('require2fa')),
        });
        break;
      case 'email':
        Object.assign(values, { 'email.fromName': v.fromName });
        break;
      default:
        throw new ValidationError({ _section: ['Unknown section'] });
    }
    await setSettings(db, values, ctx.perm.userId);
    revalidatePath('/', 'layout');
    return null;
  });
}

/** Administration → Languages. The site language is always kept enabled. */
export async function saveLanguagesAction(fd: FormData) {
  return runAction(async () => {
    const defaultLocale = String(fd.get('defaultLocale') ?? '');
    const enabled = [...new Set([defaultLocale, ...fd.getAll('enabled').map(String)])];
    await saveLanguageSettings.run(await getContext(), {
      defaultLocale,
      enabled,
      detectBrowser: fd.get('detectBrowser') === 'on',
    });
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function saveBrandingAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireConfig();
    const accent = String(fd.get('accent') ?? '');
    const values: Record<string, unknown> = { 'branding.accent': accent };
    const logo = fd.get('logo');
    if (logo instanceof File && logo.size > 0) {
      const file = await storeFile(db, {
        contextId: BRANDING_CONTEXT,
        component: 'site',
        area: 'branding',
        name: `logo-${Date.now()}-${logo.name}`,
        mimeType: logo.type,
        data: Buffer.from(await logo.arrayBuffer()),
        uploadedById: ctx.perm.userId,
        maxBytes: 1024 * 1024,
        allowedTypes: /^image\/(png|jpeg|svg\+xml|webp)$/,
      });
      values['branding.logoFileId'] = file.id;
    }
    if (fd.get('removeLogo') === 'on') values['branding.logoFileId'] = null;
    await setSettings(db, values, ctx.perm.userId);
    revalidatePath('/', 'layout');
    const p = generateAccentPalette(accent);
    return {
      adjusted: p.adjusted,
      ratio: Math.round(p.originalContrast * 100) / 100,
      accent: p.light.accent,
    };
  });
}

export async function sendTestEmailAction() {
  return runAction(async () => {
    await requireConfig();
    const user = await requireUser();
    const settings = await getAllSettings(db);
    const locale = userLocale(settings, user.locale);
    const t = createTranslator(locale, siteLocale(settings));
    const { html, text } = renderActionEmail({
      locale,
      siteName: settings['site.name'],
      heading: t('email.test.heading'),
      intro: t('email.test.intro'),
      footer: t('email.footer'),
    });
    await enqueue('email.send', {
      to: user.email,
      subject: t('email.test.subject', { site: settings['site.name'] }),
      html,
      text,
      template: 'test',
    });
    return null;
  });
}

/** Starts a "log in as" session; the permission check is in the auth endpoint. */
export async function loginAsAction(userId: string) {
  return runAction(async () => {
    await auth.api.loginAs({ body: { userId }, headers: await headers() });
    return null;
  });
}

/** Ends a "log in as" session and returns to the administrator's own account. */
export async function stopLoginAsAction() {
  return runAction(async () => {
    const { actor } = await getContext();
    if (actor.kind !== 'user' || !actor.realUserId) throw new ForbiddenError();
    await auth.api.stopImpersonating({ headers: await headers() });
    await logEvent(db, {
      name: 'user.loggedinas.stopped',
      actorId: actor.realUserId,
      realActorId: null,
      contextId: SYSTEM_CONTEXT_ID,
      objectType: 'user',
      objectId: actor.userId,
      relatedUserId: actor.userId,
    });
    return { userId: actor.userId };
  });
}
