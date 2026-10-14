import { getAllSettings, passwordExpired, passwordPolicy } from '@hubium/core';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@hubium/ui';
import { headers } from 'next/headers';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ActionForm, FormField, SubmitButton } from '@/components/action-form';
import { passwordHint } from '@/lib/password-hint';
import { changePasswordAction } from '@/server/actions/account';
import { auth } from '@/server/auth';
import { db } from '@/server/db';
import { titled } from '@/server/page-title';
import { getSession, requireUser } from '@/server/session';
import { RevokeButtons } from './revoke-buttons';
import { TwoFactorPanel } from './two-factor-panel';

export const generateMetadata = titled('settings', 'security');

function deviceLabel(ua: string | null | undefined, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /YaBrowser/.test(ua)
      ? 'Yandex Browser'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : unknown;
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}

export default async function SecuritySettings({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const user = await requireUser();
  const { required } = await searchParams;
  const [t, ta, tc, format, session, settings] = await Promise.all([
    getTranslations('settings'),
    getTranslations('auth'),
    getTranslations('common'),
    getFormatter(),
    getSession(),
    getAllSettings(db),
  ]);
  const sessions = await auth.api.listSessions({ headers: await headers() });
  const { passwordChangedAt } = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordChangedAt: true },
  });
  return (
    <div className="grid gap-6">
      {required === 'password' && user.mustChangePassword ? (
        <Alert variant="warning">
          {passwordExpired(passwordPolicy(settings), passwordChangedAt)
            ? t('requiredPasswordExpired')
            : t('requiredPassword')}
        </Alert>
      ) : null}
      {required === '2fa' && !user.twoFactorEnabled ? (
        <Alert variant="warning">{t('required2fa')}</Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('changePassword')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={changePasswordAction}
            success={t('passwordChanged')}
            resetOnSuccess
            className="grid max-w-sm gap-4"
          >
            <FormField
              name="currentPassword"
              type="password"
              label={ta('currentPassword')}
              autoComplete="current-password"
            />
            <FormField
              name="newPassword"
              type="password"
              label={ta('newPassword')}
              hint={passwordHint(ta, passwordPolicy(settings))}
              autoComplete="new-password"
            />
            <FormField
              name="newPassword2"
              type="password"
              label={ta('repeatPassword')}
              autoComplete="new-password"
            />
            <div>
              <SubmitButton>{tc('save')}</SubmitButton>
            </div>
          </ActionForm>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {t('twoFactor')}
            <Badge variant={user.twoFactorEnabled ? 'success' : 'neutral'}>
              {user.twoFactorEnabled ? t('twoFactorOn') : t('twoFactorOff')}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TwoFactorPanel enabled={user.twoFactorEnabled} issuer={settings['site.name']} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('sessions')}</CardTitle>
          <CardDescription>{t('sessionsHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {sessions.map((s) => {
              const current = s.token === session?.session.token;
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {deviceLabel(s.userAgent, t('unknownDevice'))}{' '}
                      {current ? <Badge variant="accent">{t('currentSession')}</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.ipAddress ?? '—'} · {t('lastActive')}:{' '}
                      {format.relativeTime(new Date(s.updatedAt))}
                    </p>
                  </div>
                  {current ? null : <RevokeButtons token={s.token} label={t('revoke')} />}
                </li>
              );
            })}
          </ul>
          {sessions.length > 1 ? (
            <div className="mt-3">
              <RevokeButtons all label={t('revokeOthers')} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
