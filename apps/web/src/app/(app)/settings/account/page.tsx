import { Alert, Card, CardContent, CardHeader, CardTitle, Combobox } from '@hubium/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { ProfileFieldInputs } from '@/components/profile-field-inputs';
import { changeEmailAction, updateProfileAction } from '@/server/actions/account';
import { titled } from '@/server/page-title';
import { profileFieldViews } from '@/server/profile-fields';
import { requireUser } from '@/server/session';
import { timezoneOptions } from '@/server/timezones';

export const generateMetadata = titled('settings', 'account');

export default async function AccountSettings() {
  const user = await requireUser();
  const [t, ta, tc, locale] = await Promise.all([
    getTranslations('settings'),
    getTranslations('auth'),
    getTranslations('common'),
    getLocale(),
  ]);
  const fields = await profileFieldViews(locale, { ownProfile: true });
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
            <ProfileFieldInputs
              fields={fields}
              values={(user.customFields ?? {}) as Record<string, string | boolean>}
            />
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
