import { uuidv7 } from '@hubium/db';
import { createTranslator } from '@hubium/i18n/packs';
import { z } from 'zod';
import { INDEX_ALL_JOB } from '../ai/indexing.ts';
import { LDAP_SYNC_JOB } from '../auth/ldap.ts';
import { NotFoundError } from '../errors.ts';
import { BRANDING_CONTEXT, storeFile } from '../files/files.ts';
import { enqueue } from '../jobs/jobs.ts';
import { renderActionEmail } from '../mail/mail.ts';
import { defineOperation } from '../operation.ts';
import {
  getAllSettings,
  type SettingKey,
  setSettings,
  siteLocale,
  userLocale,
} from './settings.ts';

// What Administration does with the site as a whole, as operations: the same checks, the
// same event log and one transaction, whether a page or the API asks.

/** Site settings by key; each value is checked against its setting. */
export const saveSiteSettings = defineOperation({
  name: 'site.settings.save',
  input: z.object({ values: z.record(z.string(), z.unknown()) }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, { values }) {
    await setSettings(ctx.tx, values as Partial<Record<SettingKey, unknown>>, ctx.perm.userId);
    return null;
  },
});

/** The accent colour and the logo: a new one replaces the old, which goes with it. */
export const saveBranding = defineOperation({
  name: 'site.branding.save',
  input: z.object({
    accent: z.string().max(20),
    logo: z
      .object({
        name: z.string().trim().min(1).max(200),
        mimeType: z.string().max(100),
        data: z.instanceof(Uint8Array),
      })
      .optional(),
    removeLogo: z.boolean().default(false),
  }),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx, input) {
    const values: Partial<Record<SettingKey, unknown>> = { 'branding.accent': input.accent };
    const where = { contextId: BRANDING_CONTEXT, component: 'site', area: 'branding' };
    const file = input.logo
      ? await storeFile(ctx.tx, {
          ...where,
          // a name of its own each time: two saves can fall in the same millisecond
          name: `logo-${uuidv7().slice(-12)}-${input.logo.name}`,
          mimeType: input.logo.mimeType,
          data: Buffer.from(input.logo.data),
          uploadedById: ctx.perm.userId,
          maxBytes: 1024 * 1024,
          allowedTypes: /^image\/(png|jpeg|svg\+xml|webp)$/,
        })
      : null;
    if (file) values['branding.logoFileId'] = file.id;
    else if (input.removeLogo) values['branding.logoFileId'] = null;
    // settings refused: the transaction takes the new logo back with them
    await setSettings(ctx.tx, values, ctx.perm.userId);
    // the logo replaced or removed goes; its content with the next garbage collection
    if (file || input.removeLogo)
      await ctx.tx.file.deleteMany({
        where: { ...where, ...(file ? { id: { not: file.id } } : {}) },
      });
    return { logoFileId: file?.id ?? null };
  },
});

/** A test letter to the administrator who asks, through the site's mail settings. */
export const sendTestEmail = defineOperation({
  name: 'email.test',
  input: z.object({}),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx) {
    const user = ctx.perm.userId
      ? await ctx.tx.user.findUnique({
          where: { id: ctx.perm.userId },
          select: { email: true, locale: true },
        })
      : null;
    if (!user) throw new NotFoundError('User');
    const settings = await getAllSettings(ctx.tx);
    const locale = userLocale(settings, user.locale);
    const t = createTranslator(locale, siteLocale(settings));
    const { html, text } = renderActionEmail({
      locale,
      siteName: settings['site.name'],
      heading: t('email.test.heading'),
      intro: t('email.test.intro'),
      footer: t('email.footer'),
    });
    await enqueue(
      'email.send',
      {
        to: user.email,
        subject: t('email.test.subject', { site: settings['site.name'] }),
        html,
        text,
        template: 'test',
      },
      { tx: ctx.tx },
    );
    return { to: user.email };
  },
});

/** Rebuilds what the AI tutor searches in every course: one job queues them all. */
export const reindexAllCourses = defineOperation({
  name: 'ai.reindex.all',
  input: z.object({}),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx) {
    await enqueue(INDEX_ALL_JOB, {}, { tx: ctx.tx, singletonKey: 'all' });
    return { courses: await ctx.tx.course.count({ where: { deletedAt: null } }) };
  },
});

/** Brings the directory's accounts up to date now rather than at night. */
export const startLdapSync = defineOperation({
  name: 'auth.ldap.sync',
  input: z.object({}),
  authorize: (ctx) => ctx.perm.require('site:config'),
  async handler(ctx) {
    await enqueue(LDAP_SYNC_JOB, {}, { tx: ctx.tx, singletonKey: 'sync' });
    return null;
  },
});
