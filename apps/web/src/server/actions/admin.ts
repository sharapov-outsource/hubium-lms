'use server';

import {
  assignCategoryRole,
  assignSystemRole,
  bulkUploadUsers,
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  ForbiddenError,
  installLanguagePack,
  listProfileFields,
  localizedFromForm,
  logEvent,
  profileValuesFromForm,
  removeLanguagePack,
  saveBranding,
  saveLanguageSettings,
  saveModuleSettings,
  saveSiteSettings,
  sendTestEmail,
  setMaintenanceMode,
  setRoleCapability,
  setRoleOverride,
  setUserSuspended,
  startBulkUserAction,
  unlockUser,
  updateRole,
  updateUser,
  ValidationError,
  validateProfileValues,
} from '@hubium/core';
import { readSheet } from '@hubium/core/lib/sheets';
import { SYSTEM_CONTEXT_ID, withWriteScope } from '@hubium/db';
import { msg } from '@hubium/module-sdk';
import { generateAccentPalette } from '@hubium/ui/palette';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { formBool, formToObject, runAction } from '../action';
import { auth } from '../auth';
import { db } from '../db';
import { formFile } from '../form-files';
import { getContext } from '../session';

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
      isSiteAdmin: formBool(fd.get('isSiteAdmin')),
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
      isSiteAdmin: ctx.perm.isSiteAdmin ? formBool(fd.get('isSiteAdmin')) : undefined,
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

/** Administration → Users: one action for the selected people (see core users/bulk.ts). */
export async function bulkUsersAction(selection: unknown, action: unknown) {
  return runAction(async () => {
    const r = await startBulkUserAction.run(await getContext(), {
      selection: selection as never,
      action: action as never,
    });
    revalidatePath('/admin/users');
    return r;
  });
}

/**
 * Courses or cohorts for the bulk actions on users, found by name (and short name or
 * ID): the site may have too many to list in the page.
 */
export async function bulkTargetsAction(kind: 'course' | 'cohort', q: string) {
  return runAction(async () => {
    const ctx = await getContext();
    await ctx.perm.require('user:update');
    const s = q.trim().slice(0, 100);
    const has = (v: string) => ({ contains: v, mode: 'insensitive' as const });
    if (kind === 'course') {
      const rows = await db.course.findMany({
        where: {
          deletedAt: null,
          ...(s ? { OR: [{ fullName: has(s) }, { shortName: has(s) }] } : {}),
        },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        take: 20,
        select: { id: true, fullName: true, shortName: true },
      });
      return rows.map((c) => ({ value: c.id, label: c.fullName, hint: c.shortName }));
    }
    const rows = await db.cohort.findMany({
      where: s ? { OR: [{ name: has(s) }, { idNumber: has(s) }] } : {},
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true, name: true, idNumber: true },
    });
    return rows.map((c) => ({ value: c.id, label: c.name, hint: c.idNumber ?? undefined }));
  });
}

/** Categories and courses for the permission check, found by name. */
export async function permissionContextsAction(q: string) {
  return runAction(async () => {
    const ctx = await getContext();
    await ctx.perm.require('role:manage');
    const s = q.trim().slice(0, 100);
    const has = { contains: s, mode: 'insensitive' as const };
    const [categories, courses] = await Promise.all([
      db.category.findMany({
        where: s ? { name: has } : {},
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: 10,
        select: { id: true, name: true },
      }),
      db.course.findMany({
        where: {
          deletedAt: null,
          ...(s ? { OR: [{ fullName: has }, { shortName: has }] } : {}),
        },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        take: 20,
        select: { id: true, fullName: true, shortName: true },
      }),
    ]);
    return [
      ...categories.map((c) => ({ value: c.id, label: `📁 ${c.name}` })),
      ...courses.map((c) => ({ value: c.id, label: c.fullName, hint: c.shortName })),
    ];
  });
}

export async function unlockUserAction(id: string) {
  return runAction(async () => {
    const r = await unlockUser.run(await getContext(), { id });
    revalidatePath(`/admin/users/${id}`);
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

export async function assignCategoryRoleAction(
  categoryId: string,
  userId: string,
  roleId: string,
  assigned: boolean,
) {
  return runAction(async () => {
    const r = await assignCategoryRole.run(await getContext(), {
      categoryId,
      userId,
      roleId,
      assigned,
    });
    revalidatePath(`/admin/categories/${categoryId}/permissions`);
    return r;
  });
}

export async function uploadUsersAction(fd: FormData) {
  return runAction(async () => {
    const file = await formFile(fd, 'file');
    if (!(file instanceof File) || file.size === 0)
      throw new ValidationError({ file: [msg('errors.common.chooseCsv')] });
    const rows = readSheet(new Uint8Array(await file.arrayBuffer()));
    const r = await bulkUploadUsers.run(await getContext(), { rows });
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
      name: localizedFromForm(v, 'name'),
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
      name: localizedFromForm(v, 'name'),
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

/** The settings forms' fields, by the setting each one holds: a refusal shows at its field. */
const SETTING_FIELDS: Record<string, string> = {
  'site.name': 'siteName',
  'site.defaultTimezone': 'defaultTimezone',
  'course.creatorRole': 'creatorRole',
  'recyclebin.days': 'recyclebinDays',
  'eventlog.retentionDays': 'eventlogDays',
  'registration.consentText': 'consentText',
  'password.minLength': 'minLength',
  'password.history': 'history',
  'password.maxAgeDays': 'maxAgeDays',
  'lockout.threshold': 'lockoutThreshold',
  'lockout.windowMinutes': 'lockoutWindow',
  'lockout.durationMinutes': 'lockoutDuration',
  'email.fromName': 'fromName',
  'maintenance.message': 'maintenanceMessage',
  'maintenance.until': 'maintenanceUntil',
  'branding.accent': 'accent',
  'branding.logoFileId': 'logo',
  // the uploaded logo's own check
  file: 'logo',
};

export async function saveSettingsAction(fd: FormData) {
  return runAction(
    async () => {
      const ctx = await getContext();
      const section = String(fd.get('_section'));
      const v = formToObject(fd);
      const values: Record<string, unknown> = {};
      switch (section) {
        case 'general':
          Object.assign(values, {
            'site.name': v.siteName,
            'site.defaultTimezone': v.defaultTimezone,
            'course.creatorRole': v.creatorRole,
            'recyclebin.days': Number(v.recyclebinDays ?? 30),
            'eventlog.retentionDays': Number(v.eventlogDays ?? 365),
            'mentors.enabled': formBool(fd.get('mentorsEnabled')),
          });
          break;
        case 'registration':
          Object.assign(values, {
            'registration.enabled': formBool(fd.get('enabled')),
            'registration.requireEmailVerification': formBool(fd.get('requireEmailVerification')),
            'registration.consentText': v.consentText ?? '',
          });
          break;
        case 'authentication':
          Object.assign(values, {
            'auth.oauth.google': formBool(fd.get('google')),
            'auth.oauth.yandex': formBool(fd.get('yandex')),
            'auth.oauth.vk': formBool(fd.get('vk')),
            'auth.oauth.keycloak': formBool(fd.get('keycloak')),
            'auth.require2faForAdmins': formBool(fd.get('require2fa')),
          });
          break;
        case 'security':
          Object.assign(values, {
            'password.minLength': v.minLength,
            'password.requireDigit': formBool(fd.get('requireDigit')),
            'password.requireLower': formBool(fd.get('requireLower')),
            'password.requireUpper': formBool(fd.get('requireUpper')),
            'password.requireSymbol': formBool(fd.get('requireSymbol')),
            'password.history': v.history,
            'password.maxAgeDays': v.maxAgeDays,
            'auth.newSignInNotice': formBool(fd.get('newSignInNotice')),
            'lockout.threshold': v.lockoutThreshold,
            'lockout.windowMinutes': v.lockoutWindow,
            'lockout.durationMinutes': v.lockoutDuration,
          });
          break;
        case 'email':
          Object.assign(values, { 'email.fromName': v.fromName });
          break;
        case 'maintenance':
          // logged, and the same as `hubium maintenance on|off`
          await setMaintenanceMode.run(ctx, {
            enabled: formBool(fd.get('maintenanceEnabled')),
            message: v.maintenanceMessage ?? '',
            until: v.maintenanceUntil || null,
          });
          revalidatePath('/', 'layout');
          return null;
        default:
          throw new ValidationError({ _section: [msg('errors.admin.unknownSettingsSection')] });
      }
      await saveSiteSettings.run(ctx, { values });
      revalidatePath('/', 'layout');
      return null;
    },
    { fields: SETTING_FIELDS },
  );
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

/** Installs an uploaded language pack (.zip or .json). */
export async function installLanguagePackAction(fd: FormData) {
  return runAction(async () => {
    const file = await formFile(fd, 'file');
    if (!(file instanceof File) || !file.size)
      throw new ValidationError({ file: [msg('errors.admin.chooseLanguagePack')] });
    const r = await installLanguagePack.run(await getContext(), {
      fileName: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    revalidatePath('/', 'layout');
    return r;
  });
}

export async function removeLanguagePackAction(code: string) {
  return runAction(async () => {
    await removeLanguagePack.run(await getContext(), { code });
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function saveModulesAction(fd: FormData) {
  return runAction(async () => {
    await saveModuleSettings.run(await getContext(), {
      enabled: [...new Set(fd.getAll('enabled').map(String))],
    });
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function saveBrandingAction(fd: FormData) {
  return runAction(
    async () => {
      const accent = String(fd.get('accent') ?? '');
      const logo = await formFile(fd, 'logo');
      await saveBranding.run(await getContext(), {
        accent,
        logo:
          logo instanceof File && logo.size > 0
            ? {
                name: logo.name,
                mimeType: logo.type,
                data: new Uint8Array(await logo.arrayBuffer()),
              }
            : undefined,
        removeLogo: fd.get('removeLogo') === 'on',
      });
      revalidatePath('/', 'layout');
      const p = generateAccentPalette(accent);
      return {
        adjusted: p.adjusted,
        ratio: Math.round(p.originalContrast * 100) / 100,
        accent: p.light.accent,
      };
    },
    { fields: SETTING_FIELDS },
  );
}

export async function sendTestEmailAction() {
  return runAction(async () => {
    await sendTestEmail.run(await getContext(), {});
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
    // the record of the change Better Auth just made
    await withWriteScope('auth', 'user.loginAs.stop', () =>
      logEvent(db, {
        name: 'user.loggedinas.stopped',
        actorId: actor.realUserId,
        realActorId: null,
        contextId: SYSTEM_CONTEXT_ID,
        objectType: 'user',
        objectId: actor.userId,
        relatedUserId: actor.userId,
      }),
    );
    return { userId: actor.userId };
  });
}
