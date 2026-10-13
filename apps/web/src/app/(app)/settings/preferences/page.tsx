import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@hubium/ui';
import { getTranslations } from 'next-intl/server';
import { LocaleSwitcher, ThemeSwitcher } from '@/components/locale-theme-switcher';
import { titled } from '@/server/page-title';

export const generateMetadata = titled('settings', 'preferences');

export default async function PreferencesPage() {
  const tc = await getTranslations('common');
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{tc('language')}</CardTitle>
          <CardDescription>Русский / English</CardDescription>
        </CardHeader>
        <CardContent>
          <LocaleSwitcher />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{tc('theme')}</CardTitle>
          <CardDescription>
            {tc('themeLight')} / {tc('themeDark')} / {tc('themeSystem')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeSwitcher />
        </CardContent>
      </Card>
    </div>
  );
}
