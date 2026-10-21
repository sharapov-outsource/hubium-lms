import { msg } from '@hubium/module-sdk';
import { z } from 'zod';
import type { RequestContext } from '../context.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { isTimeZone } from '../lib/zod.ts';
import { defineOperation } from '../operation.ts';
import { enabledLocales, getAllSettings } from '../settings/settings.ts';
import { listProfileFields, validateProfileValues, writeProfileValues } from './profile-fields.ts';

// What people change about their own account: their name, time zone and the profile fields
// they may fill in, and the language and theme the site shows them.

function self(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'user') throw new ForbiddenError();
  return ctx.actor.userId;
}

export const updateMyProfile = defineOperation({
  name: 'user.profile.updateOwn',
  offline: 'guarded',
  input: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    timezone: z.string().trim().max(64).optional(),
    /** Custom profile fields by short name; locked ones are left as they are. */
    profile: z.record(z.string(), z.unknown()).default({}),
  }),
  async handler(ctx, { firstName, lastName, timezone, profile }) {
    const userId = self(ctx);
    if (timezone && !isTimeZone(timezone))
      throw new ValidationError({ timezone: [msg('errors.account.unknownTimeZone')] });
    // custom profile fields the person may change themselves
    const fields = (await listProfileFields(ctx.tx)).filter((f) => !f.locked);
    const custom = validateProfileValues(fields, profile, { requireAll: true });
    await ctx.tx.user.update({
      where: { id: userId },
      data: { firstName, lastName, name: `${firstName} ${lastName}`, timezone: timezone || null },
    });
    await writeProfileValues(ctx.tx, userId, custom);
    return null;
  },
});

export const setMyPreferences = defineOperation({
  name: 'user.preferences.set',
  offline: 'guarded',
  input: z.object({
    locale: z.string().max(16).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
  }),
  async handler(ctx, { locale, theme }) {
    const userId = self(ctx);
    if (locale && !enabledLocales(await getAllSettings(ctx.tx)).includes(locale))
      throw new ValidationError({ locale: [msg('errors.field.invalid')] });
    await ctx.tx.user.update({
      where: { id: userId },
      data: { ...(locale ? { locale } : {}), ...(theme ? { theme } : {}) },
    });
    return null;
  },
});
