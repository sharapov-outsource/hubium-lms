import { describe, expect, it } from 'vitest';
import { courseFixture } from '../../test/course-fixture.ts';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { evaluateCondition } from '../courses/availability.ts';
import { ValidationError } from '../errors.ts';
import { exportUserData } from '../privacy/privacy.ts';
import {
  deleteProfileField,
  listProfileFields,
  type ProfileField,
  saveProfileField,
  validateProfileValues,
} from './profile-fields.ts';
import { bulkUploadUsers, createUser, updateUser } from './users.ts';

const field = (over: Partial<ProfileField>): ProfileField => ({
  id: 'x',
  shortName: 'f',
  name: { ru: 'Поле', en: 'Field' },
  type: 'text',
  choices: [],
  required: false,
  locked: false,
  visibleToOthers: false,
  ...over,
});

describe('profile field values', () => {
  it('coerces each type and reports errors under the form input name', () => {
    const fields = [
      field({ shortName: 'agree', type: 'checkbox' }),
      field({ shortName: 'shirt', type: 'menu', choices: ['S', 'M', 'L'] }),
      field({ shortName: 'born', type: 'date' }),
      field({ shortName: 'city', required: true }),
    ];
    expect(
      validateProfileValues(fields, {
        agree: 'да',
        shirt: 'M',
        born: '2001-02-03',
        city: ' Омск ',
      }),
    ).toEqual({ agree: true, shirt: 'M', born: '2001-02-03', city: 'Омск' });
    try {
      validateProfileValues(fields, { shirt: 'XXL', born: '03.02.2001' }, { requireAll: true });
      expect.unreachable();
    } catch (e) {
      expect((e as ValidationError).fieldErrors).toEqual({
        cf_shirt: ['Choose one of the options'],
        cf_born: ['Expected a date (YYYY-MM-DD)'],
        cf_city: ['Required'],
      });
    }
    // without requireAll, missing fields are simply left alone
    expect(validateProfileValues(fields, { city: '' })).toEqual({ city: '' });
  });

  it('matches custom fields in access conditions', () => {
    const facts = {
      now: new Date(),
      completion: new Map(),
      groupIds: new Set<string>(),
      grades: new Map(),
      profile: { 'cf:faculty': 'Физфак', 'cf:agree': '1' },
    };
    const cond = (fieldName: string, value: string) =>
      evaluateCondition({ type: 'profile', field: fieldName, op: 'equals', value }, facts);
    expect(cond('cf:faculty', 'физфак')).toBe(true);
    expect(cond('cf:agree', '1')).toBe(true);
    expect(cond('cf:missing', 'x')).toBe(false);
  });
});

describe('profile fields', () => {
  const t = useTestDb();

  it('are defined by administrators and stored on users', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveProfileField.run(admin, {
      shortName: 'faculty',
      name: { ru: 'Факультет', en: 'Faculty' },
      type: 'menu',
      choices: ['Физфак', 'Мехмат'],
    });
    const manager = await ctxFor(t.db, 'manager@hubium.local');
    await expect(
      saveProfileField.run(manager, {
        shortName: 'x1',
        name: { ru: 'X' },
        type: 'text',
      }),
    ).rejects.toThrow();

    const { id } = await createUser.run(admin, {
      email: 'pf@example.org',
      firstName: 'Ann',
      lastName: 'Lee',
      password: 'Secret12345!',
      customFields: { faculty: 'Физфак' },
    });
    await expect(
      updateUser.run(admin, { id, customFields: { faculty: 'Биофак' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateUser.run(admin, { id, customFields: { faculty: 'Мехмат' } });
    const user = await t.db.user.findUniqueOrThrow({ where: { id } });
    expect(user.customFields).toEqual({ faculty: 'Мехмат' });

    const exported = await exportUserData(admin, id);
    expect(exported.user.customFields).toEqual([{ field: 'Faculty', value: 'Мехмат' }]);

    // renaming the short name keeps the values; deleting removes them
    const [f] = await listProfileFields(t.db);
    await saveProfileField.run(admin, {
      id: f!.id,
      shortName: 'dept',
      name: { ru: 'Факультет', en: 'Faculty' },
      type: 'menu',
      choices: ['Физфак', 'Мехмат'],
    });
    expect((await t.db.user.findUniqueOrThrow({ where: { id } })).customFields).toEqual({
      dept: 'Мехмат',
    });
    await deleteProfileField.run(admin, { id: f!.id });
    expect((await t.db.user.findUniqueOrThrow({ where: { id } })).customFields).toEqual({});
  });

  it('take access conditions and SSO and LDAP mappings along when renamed', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    const { id } = await saveProfileField.run(admin, {
      shortName: 'klass',
      name: { ru: 'Класс' },
      type: 'text',
    });
    const f = await courseFixture(t.db, 'PF-REFS');
    const { id: page } = await f.addActivity('page', 'Только 7Б', { content: '<p>7Б</p>' });
    const onKlass = {
      op: '&',
      c: [{ type: 'profile', field: 'cf:klass', op: 'equals', value: '7Б' }],
    };
    await t.db.activity.update({ where: { id: page }, data: { availability: onKlass } });
    const section = await t.db.courseSection.findFirstOrThrow({ where: { courseId: f.courseId } });
    await t.db.courseSection.update({
      where: { id: section.id },
      data: {
        availability: {
          op: '|',
          c: [onKlass, { type: 'profile', field: 'email', op: 'contains', value: 'cf:klass' }],
        },
      },
    });
    const extra = { firstName: 'given_name', hubium_field_klass: 'school_class' };
    await t.db.ssoProvider.create({
      data: {
        providerId: 'school',
        issuer: 'https://idp.example.org',
        name: 'School',
        protocol: 'oidc',
        userId: admin.perm.userId!,
        oidcConfig: JSON.stringify({
          clientId: 'c',
          mapping: { email: 'email', extraFields: extra },
        }),
        mapping: { fields: { klass: 'school_class' } },
      },
    });
    await t.db.ldapServer.create({
      data: {
        url: 'ldap://ldap.example.org',
        baseDn: 'dc=example,dc=org',
        mapping: { email: 'mail', fields: { klass: 'ou' } },
      },
    });

    await saveProfileField.run(admin, {
      id,
      shortName: 'grade_class',
      name: { ru: 'Класс' },
      type: 'text',
    });
    const renamed = { type: 'profile', field: 'cf:grade_class', op: 'equals', value: '7Б' };
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: page } })).availability).toEqual({
      op: '&',
      c: [renamed],
    });
    // a condition's value is the person's text, not a field: it stays as it was
    expect(
      (await t.db.courseSection.findUniqueOrThrow({ where: { id: section.id } })).availability,
    ).toEqual({
      op: '|',
      c: [
        { op: '&', c: [renamed] },
        { type: 'profile', field: 'email', op: 'contains', value: 'cf:klass' },
      ],
    });
    const sso = await t.db.ssoProvider.findUniqueOrThrow({ where: { providerId: 'school' } });
    expect(sso.mapping).toEqual({ fields: { grade_class: 'school_class' } });
    expect(JSON.parse(sso.oidcConfig!).mapping.extraFields).toEqual({
      firstName: 'given_name',
      hubium_field_grade_class: 'school_class',
    });
    expect((await t.db.ldapServer.findUniqueOrThrow({ where: { id: 'default' } })).mapping).toEqual(
      { email: 'mail', fields: { grade_class: 'ou' } },
    );

    // a deleted field is no longer filled at sign-in; the conditions on it stay, met by no one
    await deleteProfileField.run(admin, { id });
    const after = await t.db.ssoProvider.findUniqueOrThrow({ where: { providerId: 'school' } });
    expect(after.mapping).toEqual({ fields: {} });
    expect(JSON.parse(after.oidcConfig!).mapping.extraFields).toEqual({ firstName: 'given_name' });
    expect((await t.db.ldapServer.findUniqueOrThrow({ where: { id: 'default' } })).mapping).toEqual(
      { email: 'mail', fields: {} },
    );
    expect((await t.db.activity.findUniqueOrThrow({ where: { id: page } })).availability).toEqual({
      op: '&',
      c: [renamed],
    });
  });

  it('are filled from profile_field_ columns of a CSV upload', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveProfileField.run(admin, {
      shortName: 'grade_level',
      name: { ru: 'Класс' },
      type: 'text',
    });
    await saveProfileField.run(admin, {
      shortName: 'consent',
      name: { ru: 'Согласие' },
      type: 'checkbox',
    });
    const r = await bulkUploadUsers.run(admin, {
      csv: [
        'username,firstname,lastname,password,profile_field_grade_level,profile_field_consent',
        'pupil1,Иван,Иванов,Secret12345!,7Б,да',
        'pupil2,Пётр,Петров,Secret12345!,7Б,может быть',
      ].join('\n'),
    });
    expect(r.created).toBe(1);
    expect(r.errors).toEqual([{ line: 3, message: 'profile_field_consent: Expected yes or no' }]);
    const pupil = await t.db.user.findUniqueOrThrow({ where: { username: 'pupil1' } });
    expect(pupil.customFields).toEqual({ grade_level: '7Б', consent: true });
    await expect(
      bulkUploadUsers.run(admin, {
        csv: 'username,firstname,lastname,password,profile_field_nope\nx,A,B,Secret12345!,1',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
