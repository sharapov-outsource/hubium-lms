import { describe, expect, it } from 'vitest';
import { ctxFor, useTestDb } from '../../test/helpers.ts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { setMyPreferences, updateMyProfile } from './account.ts';
import { saveProfileField } from './profile-fields.ts';

describe('own account', () => {
  const t = useTestDb();
  const me = () => t.db.user.findUniqueOrThrow({ where: { email: 'student1@hubium.local' } });

  it('changes the name, time zone and the profile fields the person may fill in', async () => {
    const admin = await ctxFor(t.db, 'admin@test.local');
    await saveProfileField.run(admin, {
      shortName: 'city',
      name: { ru: 'Город', en: 'City' },
      type: 'text',
      required: true,
    });
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    await expect(
      updateMyProfile.run(ctx, { firstName: 'Анна', lastName: 'Иванова', profile: {} }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateMyProfile.run(ctx, {
        firstName: 'Анна',
        lastName: 'Иванова',
        timezone: 'Mars/Olympus',
        profile: { city: 'Тверь' },
      }),
    ).rejects.toMatchObject({ fieldErrors: { timezone: [expect.any(String)] } });
    await updateMyProfile.run(ctx, {
      firstName: 'Анна',
      lastName: 'Иванова',
      timezone: 'Europe/Moscow',
      profile: { city: 'Тверь' },
    });
    expect(await me()).toMatchObject({
      name: 'Анна Иванова',
      timezone: 'Europe/Moscow',
      customFields: { city: 'Тверь' },
    });
  });

  it('keeps the language and theme the person picks, among the enabled languages', async () => {
    const ctx = await ctxFor(t.db, 'student1@hubium.local');
    await setMyPreferences.run(ctx, { locale: 'en', theme: 'dark' });
    expect(await me()).toMatchObject({ locale: 'en', theme: 'dark' });
    await expect(setMyPreferences.run(ctx, { locale: 'xx' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      setMyPreferences.run({ ...ctx, actor: { kind: 'anonymous' } }, { theme: 'light' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
