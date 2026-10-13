import { pickLocalized } from '@hubium/core';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@hubium/ui';
import { Download } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { requireUser } from '@/server/session';

export const generateMetadata = titled('settings', 'privacy');

export default async function PrivacySettingsPage() {
  const user = await requireUser();
  const [t, format, locale] = await Promise.all([
    getTranslations('privacy'),
    getFormatter(),
    getLocale(),
  ]);
  const accepted = await db.policyAcceptance.findMany({
    where: { userId: user.id },
    orderBy: { acceptedAt: 'desc' },
    include: { version: { include: { policy: true } } },
  });
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('exportTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">{t('exportHint')}</p>
          <Button asChild variant="outline" className="w-fit">
            <a href="/settings/privacy/export" download>
              <Download />
              {t('export')}
            </a>
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('accepted')}</CardTitle>
        </CardHeader>
        <CardContent>
          {accepted.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noneAccepted')}</p>
          ) : (
            <ul className="grid gap-1 text-sm">
              {accepted.map((a) => {
                return (
                  <li key={a.id} className="flex justify-between gap-2">
                    <span>{pickLocalized(a.version.policy.name, locale)}</span>
                    <span className="text-muted-foreground">
                      {format.dateTime(a.acceptedAt, { dateStyle: 'medium' })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t('deletion')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
