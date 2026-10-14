'use client';

import { Button } from '@hubium/ui';
import { useTranslations } from 'next-intl';
import { authClient, safeNext } from '@/lib/auth-client';

export function OAuthButtons({
  providers,
  sso = [],
  next,
}: {
  providers: ('google' | 'yandex' | 'vk')[];
  /** Single sign-on providers from Administration → Single sign-on. */
  sso?: { providerId: string; name: string }[];
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
            onClick={() =>
              p === 'yandex'
                ? authClient
                    .$fetch<{ url: string }>('/sign-in/oauth2', {
                      method: 'POST',
                      body: { providerId: 'yandex', callbackURL },
                    })
                    .then((r) => {
                      if (r.data?.url) window.location.href = r.data.url;
                    })
                : authClient.signIn.social({ provider: p, callbackURL })
            }
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
              authClient
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
