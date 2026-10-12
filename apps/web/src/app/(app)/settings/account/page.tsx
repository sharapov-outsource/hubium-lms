import { Alert, Card, CardContent, CardHeader, CardTitle } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { changeEmailAction, updateProfileAction } from '@/server/actions/account';
import { requireUser } from '@/server/session';

export default async function AccountSettings() {
  const user = await requireUser();
  const [t, ta, tc] = await Promise.all([
    getTranslations('settings'),
    getTranslations('auth'),
    getTranslations('common'),
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
            <FormField
              name="timezone"
              label={t('timezone')}
              defaultValue={user.timezone ?? ''}
              placeholder="Europe/Moscow"
              list="tz-list"
            />
            <TimezoneList />
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

function TimezoneList() {
  const zones = Intl.supportedValuesOf('timeZone');
  return (
    <datalist id="tz-list">
      {zones.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}
