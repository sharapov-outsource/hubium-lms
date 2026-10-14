'use client';

import type { BuiltInOAuth } from '@hubium/core/auth/auth';
import { Button } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { authClient, safeNext } from '@/lib/auth-client';

/** Every OAuth provider, built in or custom, signs in through the social endpoint. */
function socialSignIn(provider: string, callbackURL: string) {
  return authClient.signIn.social({
    provider: provider as Parameters<typeof authClient.signIn.social>[0]['provider'],
    callbackURL,
    errorCallbackURL: '/login',
  });
}

export function OAuthButtons({
  providers,
  sso = [],
  next,
}: {
  providers: BuiltInOAuth[];
  /** Single sign-on and custom OAuth 2 providers from Administration → Single sign-on. */
  sso?: { providerId: string; name: string; protocol: string }[];
  next?: string;
}) {
  const t = useTranslations('auth');
  if (!providers.length && !sso.length) return null;
  const callbackURL = safeNext(next);
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {t('orContinueWith')}
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-2">
        {providers.map((p) => (
          <Button
            key={p}
            type="button"
            variant="outline"
            onClick={() => socialSignIn(p, callbackURL)}
          >
            {t(p)}
          </Button>
        ))}
        {sso.map((p) => (
          <Button
            key={p.providerId}
            type="button"
            variant="outline"
            onClick={() =>
              p.protocol === 'oauth2'
                ? socialSignIn(p.providerId, callbackURL)
                : authClient
                    .$fetch<{ url: string }>('/sign-in/sso', {
                      method: 'POST',
                      body: { providerId: p.providerId, callbackURL, errorCallbackURL: '/login' },
                    })
                    .then((r) => {
                      if (r.data?.url) window.location.href = r.data.url;
                    })
            }
          >
            {p.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
