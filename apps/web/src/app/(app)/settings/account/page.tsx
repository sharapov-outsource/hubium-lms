import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Combobox,
  type ComboboxOption,
} from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { changeEmailAction, updateProfileAction } from '@/server/actions/account';
import { requireUser } from '@/server/session';

export default async function AccountSettings() {
  const user = await requireUser();
  const [t, ta, tc, locale] = await Promise.all([
    getTranslations('settings'),
    getTranslations('auth'),
    getTranslations('common'),
    getLocale(),
  ]);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('account')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={updateProfileAction}
            success={t('profileSaved')}
            className="grid gap-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                name="firstName"
                label={ta('firstName')}
                defaultValue={user.firstName}
                autoComplete="given-name"
                required
              />
              <FormField
                name="lastName"
                label={ta('lastName')}
                defaultValue={user.lastName}
                autoComplete="family-name"
                required
              />
            </div>
            <FormField name="timezone" label={t('timezone')}>
              <Combobox
                id="f-timezone"
                name="timezone"
                defaultValue={user.timezone ?? ''}
                options={[{ value: '', label: t('timezoneDefault') }, ...timezoneOptions(locale)]}
                searchPlaceholder={tc('searchPlaceholder')}
                emptyText={tc('nothingFound')}
              />
            </FormField>
            <div>
              <SubmitButton>{tc('save')}</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{ta('email')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {user.emailPlaceholder ? (
            <Alert variant="warning">{t('emailPlaceholderHint')}</Alert>
          ) : null}
          <ActionForm
            action={changeEmailAction}
            success={ta('checkEmailTitle')}
            className="flex flex-wrap items-end gap-3"
          >
            <FormField
              name="email"
              type="email"
              label={ta('email')}
              defaultValue={user.emailPlaceholder ? '' : user.email}
              className="min-w-64 flex-1"
            />
            <SubmitButton variant="secondary">{tc('save')}</SubmitButton>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}

/** Every IANA zone with its current UTC offset; the localized zone name finds it in search. */
function timezoneOptions(locale: string): ComboboxOption[] {
  const now = new Date();
  const part = (timeZone: string, timeZoneName: 'shortOffset' | 'long') =>
    new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return Intl.supportedValuesOf('timeZone').map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
    hint: part(zone, 'shortOffset').replace('GMT', 'UTC'),
    keywords: [part(zone, 'long')],
  }));
}
