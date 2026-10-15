import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { capturedJobs, ctxFor, useTestDb } from '../../test/helpers.ts';
import { INDEX_ALL_JOB, INDEX_COURSE_JOB, queueAllCourses } from '../ai/indexing.ts';
import { LDAP_SYNC_JOB } from '../auth/ldap.ts';
import { getAllSettings } from './settings.ts';
import {
  reindexAllCourses,
  saveBranding,
  saveSiteSettings,
  sendTestEmail,
  startLdapSync,
} from './site-admin.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('site administration operations', () => {
  const t = useTestDb();

  it('only those who configure the site change it, and the change is logged', async () => {
    const f = await courseFixture(t.db, 'SITEOPS');
    const teacher = await ctxFor(t.db, f.users.teacher!);
    const admin = await ctxFor(t.db, 'admin@test.local');
    for (const op of [
      () => saveSiteSettings.run(teacher, { values: { 'site.name': 'Чужой' } }),
      () => sendTestEmail.run(teacher, {}),
      () => reindexAllCourses.run(teacher, {}),
      () => startLdapSync.run(teacher, {}),
    ])
      await expect(op()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await saveSiteSettings.run(admin, { values: { 'site.name': 'Школа' } });
    expect((await getAllSettings(t.db))['site.name']).toBe('Школа');
    expect(
      await t.db.eventLog.count({
        where: { name: 'site.settings.updated', actorId: admin.perm.userId },
      }),
    ).toBe(1);
    // a value its setting refuses is said at the setting, and nothing is saved
    await expect(
      saveSiteSettings.run(admin, { values: { 'site.name': 'Другая', 'recyclebin.days': -1 } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await getAllSettings(t.db))['site.name']).toBe('Школа');
  });

  it('a new logo replaces the old one; one the settings refuse is not kept', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const logo = { name: 'logo.png', mimeType: 'image/png', data: PNG };
    const first = await saveBranding.run(admin, { accent: '#4f46e5', logo });
    const second = await saveBranding.run(admin, { accent: '#4f46e5', logo });
    const kept = await t.db.file.findMany({ where: { component: 'site', area: 'branding' } });
    expect(kept.map((f) => f.id)).toEqual([second.logoFileId]);
    expect(first.logoFileId).not.toBe(second.logoFileId);
    await expect(saveBranding.run(admin, { accent: 'not a colour', logo })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(await t.db.file.count({ where: { component: 'site', area: 'branding' } })).toBe(1);
    await saveBranding.run(admin, { accent: '#4f46e5', removeLogo: true });
    expect(await t.db.file.count({ where: { component: 'site', area: 'branding' } })).toBe(0);
  });

  it('queues the test letter, the reindexing and the directory sync as jobs', async () => {
    const f = await courseFixture(t.db, 'SITEJOBS');
    const admin = await ctxFor(t.db, 'admin@test.local');
    capturedJobs.length = 0;
    expect(await sendTestEmail.run(admin, {})).toEqual({ to: 'admin@test.local' });
    const { courses } = await reindexAllCourses.run(admin, {});
    await startLdapSync.run(admin, {});
    expect(capturedJobs.map((j) => j.name)).toEqual(['email.send', INDEX_ALL_JOB, LDAP_SYNC_JOB]);
    expect(courses).toBeGreaterThanOrEqual(1);
    // the worker's job queues every course in turn
    capturedJobs.length = 0;
    expect(await queueAllCourses(t.db)).toBe(courses);
    expect(capturedJobs.filter((j) => j.name === INDEX_COURSE_JOB)).toHaveLength(courses);
    expect(capturedJobs.some((j) => (j.data as { courseId: string }).courseId === f.courseId)).toBe(
      true,
    );
  });
});
