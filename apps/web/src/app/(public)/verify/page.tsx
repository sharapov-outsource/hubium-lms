import { normalizeCertificateCode } from '@hubium/core';
import { Button, Card, CardContent, Input } from '@hubium/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata() {
  return { title: (await getTranslations('certificates'))('verifyTitle') };
}

/** Anyone checks a certificate by the code printed on it. */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const normal = code ? normalizeCertificateCode(code) : null;
  if (normal) redirect(`/verify/${normal}`);
  const t = await getTranslations('certificates');
  return (
    <Card>
      <CardContent className="grid gap-4 pt-6">
        <h1 className="text-2xl font-semibold">{t('verifyTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('verifyIntro')}</p>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-56 flex-1 gap-1.5">
            <label htmlFor="verify-code" className="text-sm font-medium">
              {t('code')}
            </label>
            <Input
              id="verify-code"
              name="code"
              defaultValue={code}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="off"
              className="font-mono uppercase"
              aria-invalid={!!code && !normal}
              aria-describedby={code && !normal ? 'verify-error' : undefined}
            />
          </div>
          <Button type="submit">{t('verifyButton')}</Button>
        </form>
        {code && !normal ? (
          <p id="verify-error" role="alert" className="text-sm text-destructive">
            {t('badCode')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
